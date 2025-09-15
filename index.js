require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CACHE EM MEMÓRIA PARA O TOKEN ---
let tokenCache = { token: null };

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

const getBlingOrdersWithStatus = async (token, statusId) => {
    const url = `https://www.bling.com.br/Api/v3/pedidos/vendas?idsSituacoes[]=${statusId}`;
    try {
        const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) { console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message); return []; }
};

const findShopifyOrder = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `query getOrderById($id: ID!) { node(id: $id) { ... on Order { id, name, displayFinancialStatus, isArchived, fulfillmentOrders(first: 10) { edges { node { id, status, requestStatus } } } } } }`;
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
        if (userErrors && userErrors.length > 0) {
            console.error(`  - ERRO (userErrors) ao criar fulfillment no Shopify:`, userErrors);
            return false;
        }
        if (!response.data.data.fulfillmentCreateV2.fulfillment) {
            console.error(`  - ERRO SILENCIOSO: A API do Shopify não criou o fulfillment (verifique se o pedido está arquivado).`);
            return false;
        }
        return true;
    } catch (error) { console.error(`Erro na API ao criar fulfillment ${fulfillmentOrderId}:`, error.response?.data || error.message); return false; }
};

const updateBlingOrderStatus = async (token, blingOrderId, newStatusId) => {
    try {
        const response = await axios.put(`https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`, { idSituacao: newStatusId }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
        if (response.status !== 200 && response.status !== 204) {
            console.error(`  - ERRO: Bling retornou status ${response.status}.`);
            return false;
        }
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
    console.log("INICIANDO TAREFA: Verificação de pedidos 'Aguardando Retirada'.");
    const token = await getTokenFromCache();
    if (!token) { console.log("--> TAREFA ABORTADA: Token do Bling não encontrado."); return; }

    const STATUS_AGUARDANDO_RETIRADA = 299240;
    const blingOrders = await getBlingOrdersWithStatus(token, STATUS_AGUARDANDO_RETIRADA);
    
    if (!blingOrders || blingOrders.length === 0) {
        console.log("--> RESULTADO: Nenhum pedido com status 'Aguardando Retirada' foi encontrado.");
        console.log("============================== TAREFA FINALIZADA ==============================\n");
        return;
    }

    const correctShopifyStoreId = parseInt(process.env.SHOPIFY_STORE_ID_IN_BLING, 10);
    console.log(`--> Encontrados ${blingOrders.length} pedido(s) da sua loja para processar.`);

    for (const order of blingOrders) {
        if (!order.loja || order.loja.id !== correctShopifyStoreId) continue;
        const blingOrderId = order.id;
        const shopifyOrderId = order.numeroLoja;

        if (!shopifyOrderId) { console.warn(`- [Bling #${order.numero}] PULANDO: não possui 'numeroLoja'.`); continue; }

        console.log(`- [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrder(shopifyOrderId);

        if (!shopifyOrder) { console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify.`); continue; }
        
        console.log(`  - [Bling #${order.numero}] Pedido encontrado (Arquivado: ${shopifyOrder.isArchived}).`);

        if (shopifyOrder.isArchived) {
            console.warn(`  - [Bling #${order.numero}] AVISO: Pedido está ARQUIVADO no Shopify. Modificações podem falhar. Desarquive-o para garantir o funcionamento.`);
            // O código continua mesmo se estiver arquivado, para seguir a sua regra.
        }

        let wasProcessed = false;
        for (const fo of shopifyOrder.fulfillmentOrders.edges) {
            // ==================================================================
            // MUDANÇA CRÍTICA: AGORA A CONDIÇÃO É MUITO MAIS SIMPLES
            // Se a ordem de fulfillment não estiver fechada ou cancelada, nós agimos.
            // ==================================================================
            if (fo.node.status !== 'CLOSED' && fo.node.status !== 'CANCELLED') {
                wasProcessed = true;
                console.log(`  - [Bling #${order.numero}] AÇÃO: Forçando atualização do Fulfillment Order (${fo.node.id}) que está com status '${fo.node.status}'.`);
                const shopifySuccess = await markAsReadyForPickupInShopify(fo.node.id);
                
                if (shopifySuccess) {
                    console.log(`  - [Bling #${order.numero}] SUCESSO no Shopify. Atualizando Bling para 'Atendido'...`);
                    const STATUS_ATENDIDO_BLING = 9;
                    const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
                    if (blingSuccess) {
                        console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO!`);
                    } else {
                        console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar no Bling.`);
                    }
                } else {
                    console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao marcar como pronto no Shopify.`);
                }
                // Paramos o loop interno pois já agimos no fulfillment que precisava.
                break; 
            }
        }
        if (!wasProcessed) console.log(`  - [Bling #${order.numero}] Nenhuma ação necessária (todos os fulfillments já estão fechados/cancelados).`);
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