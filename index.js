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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
        });
        return response.data;
    } catch (error) {
        console.error("Erro ao obter token do Bling:", error.response?.data || error.message);
        throw error;
    }
};

// Função para buscar pedidos recentes no Bling
const getBlingOrders = async (token) => {
    const url = 'https://www.bling.com.br/Api/v3/pedidos/vendas';
    try {
        const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) {
        console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message);
        return [];
    }
};

// As funções findShopifyOrder, markAsReadyForPickupInShopify, e updateBlingOrderStatus continuam as mesmas
const findShopifyOrder = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `query getOrderById($id: ID!) { node(id: $id) { ... on Order { id, name, orderNumber, fulfillmentOrders(first: 10) { edges { node { id, status, requestStatus } } } } } }`;
    const variables = { id: shopifyGid };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query, variables }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
        const orderNode = response.data.data.node;
        return (orderNode && orderNode.id) ? orderNode : null;
    } catch (error) { console.error(`Erro na API ao buscar o pedido GID ${shopifyGid} no Shopify:`, error.response?.data?.errors || error.response?.data || error.message); return null; }
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

// --- WEBHOOK (para autenticação inicial) ---
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
    // INÍCIO DO SCRIPT DE DEBUG
    // ==================================================================
    console.log("\n\n=============== INÍCIO DO RELATÓRIO DE DEBUG ===============");
    console.log(`A API do Bling retornou ${allRecentBlingOrders.length} pedidos.`);
    console.log("--- Estrutura dos 5 primeiros pedidos recebidos: ---");
    console.log(JSON.stringify(allRecentBlingOrders.slice(0, 5), null, 2));
    
    const targetOrderNumero = "11293";
    const foundOrder = allRecentBlingOrders.find(o => o.numeroPedido == targetOrderNumero);

    if (foundOrder) {
        console.log(`\n--- Verificação do Pedido de Teste (${targetOrderNumero}) ---`);
        console.log(`✅ SUCESSO: O pedido ${targetOrderNumero} FOI ENCONTRADO na lista.`);
        console.log("Estrutura completa dele:");
        console.log(JSON.stringify(foundOrder, null, 2));
    } else {
        console.log(`\n--- Verificação do Pedido de Teste (${targetOrderNumero}) ---`);
        console.log(`❌ ATENÇÃO: O pedido ${targetOrderNumero} NÃO FOI ENCONTRADO na lista dos ${allRecentBlingOrders.length} pedidos mais recentes.`);
    }
    console.log("================= FIM DO RELATÓRIO DE DEBUG =================\n\n");
    // ==================================================================
    // FIM DO SCRIPT DE DEBUG
    // ==================================================================


    const STATUS_AGUARDANDO_RETIRADA = 299240;
    const blingOrders = allRecentBlingOrders.filter(order => order.idSituacao == STATUS_AGUARDANDO_RETIRADA);

    if (blingOrders.length === 0) {
        console.log(`Verificados ${allRecentBlingOrders.length} pedidos recentes. Nenhum com status 'Aguardando Retirada' (${STATUS_AGUARDANDO_RETIRADA}).`);
        console.log(`[${new Date().toISOString()}] Tarefa agendada finalizada.`);
        return;
    }
    
    // O resto do código continua como antes...
    const correctShopifyStoreId = parseInt(process.env.SHOPIFY_STORE_ID_IN_BLING, 10);
    console.log(`Encontrados ${blingOrders.length} pedido(s) com status correto. Filtrando pela loja ID: ${correctShopifyStoreId}...`);
    for (const order of blingOrders) {
        if (!order.loja || parseInt(order.loja, 10) !== correctShopifyStoreId) continue;
        const shopifyOrderId = order.idMagento;
        if (!shopifyOrderId) { console.warn(`- Pedido Bling ${order.id}: pulando, sem 'idMagento'.`); continue; }
        console.log(`- Processando Pedido Bling ${order.id} (Shopify ID ${shopifyOrderId})...`);
        const shopifyOrder = await findShopifyOrder(shopifyOrderId);
        if (!shopifyOrder) { console.warn(`  - Aviso: Pedido ${shopifyOrderId} não encontrado no Shopify. Pulando.`); continue; }
        for (const fo of shopifyOrder.fulfillmentOrders.edges) {
            if (fo.node.status === 'OPEN' && fo.node.requestStatus === 'UNSUBMITTED') {
                console.log(`  - Fulfillment Order ${fo.node.id} está pronto.`);
                const shopifySuccess = await markAsReadyForPickupInShopify(fo.node.id);
                if (shopifySuccess) {
                    console.log(`  - Sucesso no Shopify.`);
                    const blingSuccess = await updateBlingOrderStatus(token, order.id, 9);
                    if (blingSuccess) { console.log(`  - ✅ Sucesso Completo: Status do pedido ${order.id} atualizado para 'Atendido' no Bling.`); }
                    else { console.error(`  - ❌ Erro Crítico: Shopify OK, mas FALHA ao atualizar status no Bling para o pedido ${order.id}.`); }
                } else { console.error(`  - ❌ Falha ao marcar como pronto no Shopify.`); }
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