require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CACHE EM MEMÓRIA PARA O TOKEN ---
// Este objeto simples servirá como nosso "banco de dados" em memória.
// Ele será resetado toda vez que a aplicação reiniciar.
let tokenCache = {
    token: null,
    refreshToken: null,
    scope: null,
    updatedAt: null,
};

// Função para salvar o token no cache em memória
const saveTokenToCache = (tokenData) => {
    tokenCache.token = tokenData.access_token;
    tokenCache.refreshToken = tokenData.refresh_token;
    tokenCache.scope = tokenData.scope;
    tokenCache.updatedAt = new Date();
    console.log("Token do Bling salvo com sucesso no cache em memória.");
    // Retornamos uma Promise para manter a consistência com a versão async do DB
    return Promise.resolve();
};

// Função para buscar o token do cache em memória
const getTokenFromCache = () => {
    if (tokenCache.token) {
        return Promise.resolve(tokenCache.token);
    }
    console.warn("Nenhum token encontrado no cache. Por favor, autorize a aplicação primeiro.");
    return Promise.resolve(null);
};


// --- SERVIÇOS (LÓGICA DE NEGÓCIO - SEM ALTERAÇÕES AQUI) ---

// Função para obter o token do Bling usando o código de autorização
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

// Função para buscar pedidos "Aguardando Retirada" no Bling
const getBlingOrders = async (token) => {
    try {
        const response = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas?idSituacao=299240', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data.data;
    } catch (error) {
        console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message);
        return [];
    }
};

const findShopifyOrder = async (orderNumber) => {
    // CONSTRUÍMOS A QUERY DE BUSCA CORRETAMENTE AQUI
    // O Shopify geralmente busca o nome do pedido com o prefixo '#'
    const shopifySearchQuery = `name:${orderNumber}`;

    const query = `
      query getOrderDetails($searchQuery: String!) {
        orders(first: 1, query: $searchQuery) {
          edges {
            node {
              id
              name
              fulfillmentOrders(first: 10) {
                edges {
                  node {
                    id
                    status
                    requestStatus
                  }
                }
              }
            }
          }
        }
      }`;
      
    // A variável agora é a string de busca completa
    const variables = { searchQuery: shopifySearchQuery };

    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query, variables }, {
            headers: {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json',
            }
        });
        
        if (response.data.data.orders.edges.length > 0) {
            return response.data.data.orders.edges[0].node;
        }
        
        // Se chegou aqui, não encontrou nada.
        return null;

    } catch (error) {
        // Adicionamos mais detalhes no log de erro para facilitar a depuração
        console.error(`Erro na chamada da API para buscar o pedido ${orderNumber} no Shopify:`, 
            error.response?.data?.errors || error.response?.data || error.message);
        return null;
    }
};

// Função para marcar um pedido como pronto para retirada no Shopify (usando a mutação correta)
const markAsReadyForPickupInShopify = async (fulfillmentOrderId) => {
    const mutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }`;
    const variables = {
        "fulfillment": {
            "lineItemsByFulfillmentOrder": [{
                "fulfillmentOrderId": fulfillmentOrderId
            }],
            "notifyCustomer": true
        }
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
    if (!code) {
        return res.status(400).send("Parâmetro 'code' ausente.");
    }
    try {
        console.log("Recebido código de autorização. Solicitando token...");
        const tokenData = await getBlingToken(code);
        await saveTokenToCache(tokenData); // <<== MODIFICADO
        res.status(200).send("Autenticação com Bling concluída e token salvo com sucesso no cache!");
    } catch (error) {
        res.status(500).send("Falha ao processar a autenticação do Bling.");
    }
});


// --- LÓGICA PRINCIPAL DA AUTOMAÇÃO (CRON JOB) ---
const processOrders = async () => {
    console.log(`[${new Date().toISOString()}] Iniciando a tarefa agendada de processamento de pedidos.`);
    const token = await getTokenFromCache(); // <<== MODIFICADO
    if (!token) {
        console.log("Tarefa abortada: token do Bling não encontrado no cache.");
        return;
    }

    const blingOrders = await getBlingOrders(token);
    if (!blingOrders || blingOrders.length === 0) {
        console.log("Nenhum pedido 'Aguardando Retirada' encontrado no Bling.");
        return;
    }
    console.log(`Encontrados ${blingOrders.length} pedidos para processar.`);

    for (const order of blingOrders) {
        const blingOrderId = order.id;
        const shopifyOrderNumber = order.numeroLoja;
        if (!shopifyOrderNumber) {
            console.warn(`- Pedido Bling ${blingOrderId}: pulando, pois não possui 'numeroLoja'.`);
            continue;
        }

        console.log(`- Processando Pedido Bling ${blingOrderId} (Shopify #${shopifyOrderNumber})...`);
        const shopifyOrder = await findShopifyOrder(shopifyOrderNumber);
        if (!shopifyOrder) {
            console.error(`  - Erro: Pedido #${shopifyOrderNumber} não encontrado no Shopify.`);
            continue;
        }

        for (const fo of shopifyOrder.fulfillmentOrders.edges) {
            const fulfillmentNode = fo.node;
            if (fulfillmentNode.status === 'OPEN' && fulfillmentNode.requestStatus === 'UNSUBMITTED') {
                console.log(`  - Fulfillment Order ${fulfillmentNode.id} está pronto para ser marcado.`);
                const shopifySuccess = await markAsReadyForPickupInShopify(fulfillmentNode.id);

                if (shopifySuccess) {
                    console.log(`  - Sucesso: Pedido marcado como 'pronto para retirada' no Shopify.`);
                    const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, 299241);
                    if (blingSuccess) {
                        console.log(`  - ✅ Sucesso Completo: Status do pedido ${blingOrderId} atualizado no Bling.`);
                    } else {
                        console.error(`  - ❌ Erro Crítico: Shopify foi atualizado, mas FALHOU ao atualizar o status no Bling para o pedido ${blingOrderId}.`);
                    }
                } else {
                    console.error(`  - ❌ Falha: Não foi possível marcar o pedido como 'pronto para retirada' no Shopify.`);
                }
            } else {
                console.log(`  - Info: Fulfillment Order ${fulfillmentNode.id} não está pronto para retirada (Status: ${fulfillmentNode.status}).`);
            }
        }
    }
    console.log(`[${new Date().toISOString()}] Tarefa agendada finalizada.`);
};


// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    // A inicialização do banco de dados não é mais necessária.
    cron.schedule('*/30 * * * * *', processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa de processamento de pedidos agendada para executar a cada 2 minutos.');
    console.log(`Para autorizar com o Bling, acesse o endpoint de callback: /webhook/bling/callback`);
});