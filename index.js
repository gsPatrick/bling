require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CACHE EM MEMÓRIA PARA O TOKEN ---
let tokenCache = { token: null };

// Funções para gerenciar o token em memória
const saveTokenToCache = (tokenData) => {
    tokenCache.token = tokenData.access_token;
    console.log("Token do Bling salvo com sucesso no cache em memória.");
    return Promise.resolve();
};

const getTokenFromCache = () => {
    if (tokenCache.token) return Promise.resolve(tokenCache.token);
    console.warn("Nenhum token encontrado no cache. Por favor, autorize a aplicação primeiro.");
    return Promise.resolve(null);
};


// --- SERVIÇOS (LÓGICA DE NEGÓCIO) ---

// Função para obter o token do Bling
const getBlingToken = async (code) => {
    const credentials = Buffer.from(`${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.BLING_REDIRECT_URI,
    });
    try {
        const response = await axios.post('https://bling.com.br/Api/v3/oauth/token', body, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${credentials}`,
            },
        });
        return response.data;
    } catch (error) {
        console.error("Erro ao obter token do Bling:", error.response?.data || error.message);
        throw error;
    }
};

// Função para buscar pedidos recentes no Bling (sem filtro de status na API)
const getBlingOrders = async (token) => {
    const url = 'https://www.bling.com.br/Api/v3/pedidos/vendas';
    try {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) {
        console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message);
        return [];
    }
};

// Função para encontrar pedido no Shopify pelo ID
const findShopifyOrder = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `
      query getOrderById($id: ID!) {
        node(id: $id) {
          ... on Order {
            id, name, orderNumber,
            fulfillmentOrders(first: 10) { edges { node { id, status, requestStatus } } }
          }
        }
      }`;
    const variables = { id: shopifyGid };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query, variables }, {
            headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }
        });
        const orderNode = response.data.data.node;
        return (orderNode && orderNode.id) ? orderNode : null;
    } catch (error) {
        console.error(`Erro na API ao buscar o pedido GID ${shopifyGid} no Shopify:`, error.response?.data?.errors || error.response?.data || error.message);
        return null;
    }
};

// Função para marcar um pedido como pronto para retirada no Shopify
const markAsReadyForPickupInShopify = async (fulfillmentOrderId) => {
    const mutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id, status }, userErrors { field, message }
        }
      }`;
    const variables = {
        "fulfillment": { "lineItemsByFulfillmentOrder": [{ "fulfillmentOrderId": fulfillmentOrderId }], "notifyCustomer": true }
    };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query: mutation, variables }, {
            headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }
        });
        const userErrors = response.data.data?.fulfillmentCreateV2?.userErrors;
        if (userErrors && userErrors.length > 0) {
            console.error(`Erro ao criar fulfillment para ${fulfillmentOrderId} no Shopify:`, userErrors);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`Erro na API ao criar fulfillment ${fulfillmentOrderId}:`, error.response?.data || error.message);
        return false;
    }
};

// Função para atualizar o status do pedido no Bling
const updateBlingOrderStatus = async (token, blingOrderId, newStatusId) => {
    try {
        await axios.put(`https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`, { idSituacao: newStatusId }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        return true;
    } catch (error) {
        console.error(`Erro ao atualizar status do pedido ${blingOrderId} no Bling:`, error.response?.data || error.message);
        return false;
    }
};

// --- WEBHOOK (para autenticação inicial) ---
app.get('/webhook/bling/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send("Parâmetro 'code' ausente.");
    try {
        console.log("Recebido código de autorização. Solicitando token...");
        const tokenData = await getBlingToken(code);
        await saveTokenToCache(tokenData);
        res.status(200).send("Autenticação com Bling concluída e token salvo com sucesso no cache!");
    } catch (error) {
        res.status(500).send("Falha ao processar a autenticação do Bling.");
    }
});

// --- LÓGICA PRINCIPAL DA AUTOMAÇÃO (CRON JOB) ---
const processOrders = async () => {
    console.log(`[${new Date().toISOString()}] Iniciando a tarefa agendada.`);
    const token = await getTokenFromCache();
    if (!token) {
        console.log("Tarefa abortada: token do Bling não encontrado.");
        return;
    }

    const allRecentBlingOrders = await getBlingOrders(token);
    if (!allRecentBlingOrders || allRecentBlingOrders.length === 0) {
        console.log("Nenhum pedido recente encontrado no Bling.");
        return;
    }

    // ==================================================================
    // CORREÇÃO FINAL DO FILTRO DE STATUS
    // A lista de pedidos usa 'idSituacao' diretamente no objeto.
    // ==================================================================
    const STATUS_AGUARDANDO_RETIRADA = 299240;
    const blingOrders = allRecentBlingOrders.filter(order => 
        // Usamos '==' para comparar a string "299240" com o número 299240
        order.idSituacao == STATUS_AGUARDANDO_RETIRADA
    );

    if (blingOrders.length === 0) {
        console.log(`Verificados ${allRecentBlingOrders.length} pedidos recentes. Nenhum com status 'Aguardando Retirada' (${STATUS_AGUARDANDO_RETIRADA}).`);
        console.log(`[${new Date().toISOString()}] Tarefa agendada finalizada.`);
        return;
    }

    const correctShopifyStoreId = parseInt(process.env.SHOPIFY_STORE_ID_IN_BLING, 10);
    if (!correctShopifyStoreId) {
        console.error("ERRO CRÍTICO: SHOPIFY_STORE_ID_IN_BLING não está no .env. Abortando.");
        return;
    }

    console.log(`Encontrados ${blingOrders.length} pedido(s) com status correto. Filtrando pela loja ID: ${correctShopifyStoreId}...`);

    for (const order of blingOrders) {
        // O filtro de loja usa a propriedade 'loja', que parece ser uma string na lista.
        // Convertemos para número para garantir a comparação correta.
        if (!order.loja || parseInt(order.loja, 10) !== correctShopifyStoreId) {
            continue;
        }

        const blingOrderId = order.id;
        // O ID do Shopify na lista simplificada está no campo 'idMagento'.
        const shopifyOrderId = order.idMagento;

        if (!shopifyOrderId) {
            console.warn(`- Pedido Bling ${blingOrderId}: pulando, sem 'idMagento' (ID do Shopify).`);
            continue;
        }

        console.log(`- Processando Pedido Bling ${blingOrderId} (Shopify ID ${shopifyOrderId})...`);
        const shopifyOrder = await findShopifyOrder(shopifyOrderId);

        if (!shopifyOrder) {
            console.warn(`  - Aviso: Pedido ${shopifyOrderId} não encontrado no Shopify (pode já ter sido processado/arquivado). Pulando.`);
            continue;
        }

        for (const fo of shopifyOrder.fulfillmentOrders.edges) {
            const fulfillmentNode = fo.node;
            if (fulfillmentNode.status === 'OPEN' && fulfillmentNode.requestStatus === 'UNSUBMITTED') {
                console.log(`  - Fulfillment Order ${fulfillmentNode.id} está pronto.`);
                const shopifySuccess = await markAsReadyForPickupInShopify(fulfillmentNode.id);

                if (shopifySuccess) {
                    console.log(`  - Sucesso no Shopify.`);
                    const STATUS_ATENDIDO_BLING = 9;
                    const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
                    if (blingSuccess) {
                        console.log(`  - ✅ Sucesso Completo: Status do pedido ${blingOrderId} atualizado para 'Atendido' no Bling.`);
                    } else {
                        console.error(`  - ❌ Erro Crítico: Shopify OK, mas FALHA ao atualizar status no Bling para o pedido ${blingOrderId}.`);
                    }
                } else {
                    console.error(`  - ❌ Falha ao marcar como pronto no Shopify.`);
                }
            }
        }
    }
    console.log(`[${new Date().toISOString()}] Tarefa agendada finalizada.`);
};
// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    cron.schedule('*/30 * * * * *', processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa agendada para executar a cada 2 minutos.');
});