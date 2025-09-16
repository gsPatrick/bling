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

// --- AUTENTICAÇÃO BLING ---
const getBlingToken = async (code) => {
    const credentials = Buffer.from(`${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: process.env.BLING_REDIRECT_URI });

    try {
        const response = await axios.post('https://bling.com.br/Api/v3/oauth/token', body, { 
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded', 
                'Authorization': `Basic ${credentials}` 
            } 
        });
        return response.data;
    } catch (error) { 
        console.error("Erro ao obter token do Bling:", error.response?.data || error.message); 
        throw error; 
    }
};

// --- CONSULTA PEDIDOS BLING ---
const getBlingOrdersWithStatus = async (token, statusId) => {
    const url = `https://www.bling.com.br/Api/v3/pedidos/vendas?idsSituacoes[]=${statusId}`;
    try {
        const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) { 
        console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message); 
        return []; 
    }
};

// --- CONSULTA PEDIDO SHOPIFY ---
const findShopifyOrderWithFulfillments = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `
        query getOrderById($id: ID!) {
            node(id: $id) {
                ... on Order {
                    id
                    name
                    displayFulfillmentStatus
                    shippingLine { title }
                }
            }
        }
    `;
    const variables = { id: shopifyGid };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query, variables }, { 
            headers: { 
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 
                'Content-Type': 'application/json' 
            } 
        });
        if (response.data.errors) { 
            console.error(`  - ERRO DE QUERY GRAPHQL para o ID GID ${shopifyGid}:`, response.data.errors); 
            return null; 
        }
        const orderNode = response.data.data.node;
        return (orderNode && orderNode.id) ? orderNode : null;
    } catch (error) { 
        console.error(`  - ERRO DE CONEXÃO na API Shopify para o ID GID ${shopifyGid}:`, error.message); 
        return null; 
    }
};

// --- MARCAR PEDIDO COMO PRONTO PARA RETIRADA ---
const markOrderAsReadyForPickup = async (orderId) => {
    const mutation = `
        mutation MarkOrderReadyForPickup($id: ID!) {
            orderReadyForPickup(id: $id) {
                order {
                    id
                    displayFulfillmentStatus
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;
    const variables = { id: orderId };

    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query: mutation, variables }, { 
            headers: { 
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 
                'Content-Type': 'application/json' 
            } 
        });

        if (response.data.errors) {
            console.error("❌ Erro GraphQL:", response.data.errors);
            return false;
        }

        const userErrors = response.data.data?.orderReadyForPickup?.userErrors;
        if (userErrors?.length) {
            console.error("❌ Erro ao marcar como pronto para retirada:", userErrors);
            return false;
        }

        console.log(`✅ Pedido ${orderId} marcado como pronto para retirada`);
        return true;
    } catch (err) {
        console.error(`❌ Erro de conexão:`, err.response?.data || err.message);
        return false;
    }
};

// --- ATUALIZAÇÃO DO STATUS NO BLING ---
const updateBlingOrderStatus = async (token, blingOrderId, newStatusId) => {
    try {
        await axios.put(`https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`, { idSituacao: newStatusId }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
        return true;
    } catch (error) { 
        console.error(`Erro ao atualizar status do pedido ${blingOrderId} no Bling:`, error.response?.data || error.message); 
        return false; 
    }
};

// --- WEBHOOK PARA AUTENTICAÇÃO BLING ---
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

// --- LÓGICA PRINCIPAL DE PROCESSAMENTO ---
const processOrders = async () => {
    console.log(`\n========================= [${new Date().toISOString()}] =========================`);
    console.log("INICIANDO TAREFA: Verificação de pedidos 'Aguardando Retirada'.");

    const token = await getTokenFromCache();
    if (!token) { 
        console.log("--> TAREFA ABORTADA: Token do Bling não encontrado."); 
        return; 
    }

    const STATUS_AGUARDANDO_RETIRADA = 299240;
    const blingOrders = await getBlingOrdersWithStatus(token, STATUS_AGUARDANDO_RETIRADA);

    if (!blingOrders || blingOrders.length === 0) {
        console.log("--> RESULTADO: Nenhum pedido com status 'Aguardando Retirada' foi encontrado.");
        console.log("============================== TAREFA FINALIZADA ==============================\n");
        return;
    }

    const correctShopifyStoreId = parseInt(process.env.SHOPIFY_STORE_ID_IN_BLING, 10);
    const ordersToProcess = blingOrders.filter(order => order.loja && order.loja.id === correctShopifyStoreId);

    if (ordersToProcess.length === 0) {
        console.log(`--> ${blingOrders.length} pedido(s) encontrados, mas nenhum pertence à sua loja (ID ${correctShopifyStoreId}).`);
        console.log("============================== TAREFA FINALIZADA ==============================\n");
        return;
    }
    
    console.log(`--> Encontrados ${ordersToProcess.length} pedido(s) da sua loja para processar.`);

    for (const order of ordersToProcess) {
        const blingOrderId = order.id;
        const shopifyOrderId = order.numeroLoja;

        if (!shopifyOrderId) { 
            console.warn(`- [Bling #${order.numero}] PULANDO: não possui 'numeroLoja'.`); 
            continue; 
        }

        console.log(`- [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrderWithFulfillments(shopifyOrderId);

        if (!shopifyOrder) { 
            console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify.`); 
            continue; 
        }
        
        console.log(`  - [Bling #${order.numero}] Status atual: ${shopifyOrder.displayFulfillmentStatus}, Método de entrega: ${shopifyOrder.shippingLine?.title || 'N/A'}`);

        const isPickupOrder = shopifyOrder.shippingLine?.title?.toLowerCase().includes('sede') || 
                              shopifyOrder.shippingLine?.title?.toLowerCase().includes('retirada') ||
                              shopifyOrder.shippingLine?.title?.toLowerCase().includes('pickup');

        if (!isPickupOrder) {
            console.log(`  - [Bling #${order.numero}] PULANDO: Não é um pedido de retirada (método: ${shopifyOrder.shippingLine?.title})`);
            continue;
        }

        console.log(`  - [Bling #${order.numero}] Marcando pedido como pronto para retirada...`);
        const success = await markOrderAsReadyForPickup(shopifyOrder.id);

        if (!success) {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao criar fulfillment para pickup.`);
            continue;
        }

        console.log(`  - ✅ [Bling #${order.numero}] Fulfillment criado com sucesso - pedido marcado como pronto para retirada.`);
        
        const STATUS_ATENDIDO_BLING = 9;
        const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
        if (blingSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO!`);
        } else {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar no Bling.`);
        }
    }

    console.log("============================== TAREFA FINALIZADA ==============================\n");
};

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    cron.schedule("*/30 * * * * *", processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa agendada para executar a cada 30 segundos.');
});
