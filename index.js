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

const getBlingToken = async (code) => {
    const credentials = Buffer.from(`${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: process.env.BLING_REDIRECT_URI });
    try {
        const response = await axios.post('https://bling.com.br/Api/v3/oauth/token', body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` } });
        return response.data;
    } catch (error) { console.error("Erro ao obter token do Bling:", error.response?.data || error.message); throw error; }
};

// Função para buscar os 100 pedidos mais recentes (vamos filtrar no nosso código)
const getRecentBlingOrders = async (token) => {
    const url = 'https://www.bling.com.br/Api/v3/pedidos/vendas';
    try {
        const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) { console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message); return []; }
};

// Função para encontrar pedido no Shopify (usando o método de busca direto e robusto)
const findShopifyOrder = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `
      query getOrderById($id: ID!) {
        node(id: $id) {
          ... on Order {
            id, name, displayFinancialStatus,
            fulfillmentOrders(first: 10) { edges { node { id, status, requestStatus } } }
          }
        }
      }`;
    const variables = { id: shopifyGid };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query, variables }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
        if (response.data.errors) { console.error(`  - ERRO DE QUERY GRAPHQL para o ID GID ${shopifyGid}:`, response.data.errors); return null; }
        const orderNode = response.data.data.node;
        return (orderNode && orderNode.id) ? orderNode : null;
    } catch (error) { console.error(`  - ERRO DE CONEXÃO na API Shopify para o ID GID ${shopifyGid}:`, error.message); return null; }
};

const markAsReadyForPickupInShopify = async (fulfillmentOrderId) => {
    const mutation = `mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) { fulfillmentCreateV2(fulfillment: $fulfillment) { fulfillment { id, status }, userErrors { field, message } } }`;
    const variables = { "fulfillment": { "lineItemsByFulfillmentOrder": [{ "fulfillmentOrderId": fulfillmentOrderId }], "notifyCustomer": true } };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query: mutation, variables }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
        const userErrors = response.data.data?.fulfillmentCreateV2?.userErrors;
        if (userErrors && userErrors.length > 0) { console.error(`Erro ao criar fulfillment para ${fulfillmentOrderId} no Shopify:`, userErrors); return false; }
        return true;
    } catch (error) { console.error(`Erro na API ao criar fulfillment ${fulfillmentOrderId}:`, error.response?.data || error.message); return false; }
};

const updateBlingOrderStatus = async (token, blingOrderId, newStatusId) => {
    try {
        await axios.put(`https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`, { idSituacao: newStatusId }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
        return true;
    } catch (error) { console.error(`Erro ao atualizar status do pedido ${blingOrderId} no Bling:`, error.response?.data || error.message); return false; }
};

// --- WEBHOOK ---
app.get('/webhook/bling/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send("Parâmetro 'code' ausente.");
    try {
        console.log("Recebido código de autorização. Solicitando token...");
        const tokenData = await getBlingToken(code);
        await saveTokenToCache(tokenData);
        res.status(200).send("Autenticação com Bling concluída e token salvo com sucesso no cache!");
    } catch (error) { res.status(500).send("Falha ao processar a autenticação do Bling."); }
});

// --- LÓGICA PRINCIPAL ---
const processOrders = async () => {
    console.log(`\n========================= [${new Date().toISOString()}] =========================`);
    console.log("INICIANDO TAREFA: Verificação de pedidos.");
    
    const token = await getTokenFromCache();
    if (!token) { console.log("--> TAREFA ABORTADA: Token do Bling não encontrado."); return; }

    const allRecentBlingOrders = await getRecentBlingOrders(token);
    if (!allRecentBlingOrders || allRecentBlingOrders.length === 0) {
        console.log("--> RESULTADO: Nenhum pedido recente foi encontrado no Bling.");
        console.log("============================== TAREFA FINALIZADA ==============================\n");
        return;
    }

    const correctShopifyStoreId = parseInt(process.env.SHOPIFY_STORE_ID_IN_BLING, 10);
    const STATUS_AGUARDANDO_RETIRADA = 299240;

    // FILTRO FINAL E CORRETO, BASEADO NOS DADOS REAIS
    const ordersToProcess = allRecentBlingOrders.filter(order => 
        order.situacao && order.situacao.id === STATUS_AGUARDANDO_RETIRADA &&
        order.loja && order.loja.id === correctShopifyStoreId
    );

    if (ordersToProcess.length === 0) {
        console.log(`--> Verificados ${allRecentBlingOrders.length} pedidos. Nenhum 'Aguardando Retirada' da sua loja foi encontrado.`);
        console.log("============================== TAREFA FINALIZADA ==============================\n");
        return;
    }
    
    console.log(`--> Encontrados ${ordersToProcess.length} pedido(s) da sua loja para processar:`);
    console.log("----------------------------------------------------------------------");

    for (const order of ordersToProcess) {
        const blingOrderId = order.id;
        const shopifyOrderId = order.numeroLoja;

        if (!shopifyOrderId) {
            console.warn(`- [Bling #${order.numero}] PULANDO: não possui 'numeroLoja' (ID do Shopify).`);
            continue;
        }

        console.log(`- [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrder(shopifyOrderId);

        if (!shopifyOrder) {
            console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify. Verifique se o ID ${shopifyOrderId} está correto no Bling.`);
            continue;
        }
        
        console.log(`  - [Bling #${order.numero}] Pedido encontrado no Shopify (Status Financeiro: ${shopifyOrder.displayFinancialStatus}).`);

        let wasProcessed = false;
        for (const fo of shopifyOrder.fulfillmentOrders.edges) {
            if (fo.node.status === 'OPEN' && fo.node.requestStatus === 'UNSUBMITTED') {
                wasProcessed = true; // Marca que encontramos uma ação a ser feita.
                console.log(`  - [Bling #${order.numero}] Fulfillment Order (${fo.node.id}) está pronto para retirada. Atualizando Shopify...`);
                const shopifySuccess = await markAsReadyForPickupInShopify(fo.node.id);
                
                if (shopifySuccess) {
                    console.log(`  - [Bling #${order.numero}] SUCESSO no Shopify. Atualizando Bling para 'Atendido'...`);
                    const STATUS_ATENDIDO_BLING = 9;
                    const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
                    if (blingSuccess) {
                        console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO! Pedido atualizado para 'Atendido' no Bling.`);
                    } else {
                        console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar status no Bling.`);
                    }
                } else {
                    console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao marcar como pronto no Shopify.`);
                }
            }
        }
        if (!wasProcessed) {
             console.log(`  - [Bling #${order.numero}] Nenhuma ação necessária no Shopify (pedido já processado ou sem itens para retirada).`);
        }
    }
    console.log("============================== TAREFA FINALIZADA ==============================\n");
};

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
     cron.schedule('*/30 * * * * *', processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa agendada para executar a cada 2 minutos.');
});