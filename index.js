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

// FUNÇÃO ATUALIZADA: Busca o pedido com detalhes completos
const findShopifyOrderWithFulfillments = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `
        query getOrderById($id: ID!) {
            node(id: $id) {
                ... on Order {
                    id
                    name
                    displayFulfillmentStatus
                    shippingLine {
                        title
                    }
                    fulfillmentOrders(first: 10) {
                        edges {
                            node {
                                id
                                status
                                deliveryMethod {
                                    methodType
                                }
                                lineItems(first: 50) {
                                    edges {
                                        node {
                                            id
                                            remainingQuantity
                                        }
                                    }
                                }
                            }
                        }
                    }
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

// NOVA FUNÇÃO: Cria um fulfillment para pickup (quando o pedido está UNFULFILLED)
// Corrigido: cria fulfillment via lineItemsByFulfillmentOrder
const createPickupFulfillment = async (orderId) => {
    // Query para pegar os fulfillmentOrders e seus itens
    const fulfillmentOrderQuery = `
        query getFulfillmentOrders($id: ID!) {
            node(id: $id) {
                ... on Order {
                    id
                    fulfillmentOrders(first: 10) {
                        edges {
                            node {
                                id
                                status
                                lineItems(first: 50) {
                                    edges {
                                        node {
                                            id
                                            remainingQuantity
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        const fulfillmentOrderResponse = await axios.post(process.env.SHOPIFY_API_URL, {
            query: fulfillmentOrderQuery,
            variables: { id: orderId }
        }, {
            headers: {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        if (fulfillmentOrderResponse.data.errors) {
            console.error(`  - ERRO ao buscar fulfillmentOrders do pedido ${orderId}:`, fulfillmentOrderResponse.data.errors);
            return false;
        }

        const fulfillmentOrders = fulfillmentOrderResponse.data.data.node.fulfillmentOrders.edges;
        if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
            console.error(`  - ERRO: Nenhum fulfillmentOrder encontrado no pedido ${orderId}`);
            return false;
        }

        // Monta os lineItemsByFulfillmentOrder
        const lineItemsByFulfillmentOrder = fulfillmentOrders.map(edge => {
            const orderLineItems = edge.node.lineItems.edges
                .filter(item => item.node.remainingQuantity > 0)
                .map(item => ({
                    id: item.node.id,
                    quantity: item.node.remainingQuantity
                }));

            return {
                fulfillmentOrderId: edge.node.id,
                fulfillmentOrderLineItems: orderLineItems
            };
        }).filter(entry => entry.fulfillmentOrderLineItems.length > 0);

        if (lineItemsByFulfillmentOrder.length === 0) {
            console.log(`  - AVISO: Nenhum item disponível para fulfillment no pedido ${orderId}`);
            return false;
        }

        // Mutation correta usando lineItemsByFulfillmentOrder
        const fulfillmentMutation = `
            mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
                fulfillmentCreate(fulfillment: $fulfillment) {
                    fulfillment {
                        id
                        status
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        const fulfillmentVariables = {
            fulfillment: {
                lineItemsByFulfillmentOrder,
                notifyCustomer: false,
                trackingInfo: {
                    company: "Pickup Local",
                    number: "READY_FOR_PICKUP"
                }
            }
        };

        const fulfillmentResponse = await axios.post(process.env.SHOPIFY_API_URL, {
            query: fulfillmentMutation,
            variables: fulfillmentVariables
        }, {
            headers: {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        if (fulfillmentResponse.data.errors) {
            console.error(`  - ERRO ao criar fulfillment para ${orderId}:`, fulfillmentResponse.data.errors);
            return false;
        }

        const userErrors = fulfillmentResponse.data.data?.fulfillmentCreate?.userErrors;
        if (userErrors && userErrors.length > 0) {
            console.error(`  - ERRO (userErrors) ao criar fulfillment para ${orderId}:`, userErrors);
            return false;
        }

        console.log(`  - ✅ Fulfillment criado com sucesso para ${orderId}`);
        return true;

    } catch (error) {
        console.error(`Erro na API ao criar fulfillment para pickup ${orderId}:`, error.response?.data || error.message);
        return false;
    }
};

const markOrderReadyForPickup = async (fulfillmentOrderId) => {
    const mutation = `
        mutation fulfillmentOrderMarkAsReadyForPickup($id: ID!) {
            fulfillmentOrderMarkAsReadyForPickup(id: $id) {
                fulfillmentOrder {
                    id
                    status
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;
    const variables = { id: fulfillmentOrderId };
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { query: mutation, variables }, { 
            headers: { 
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 
                'Content-Type': 'application/json' 
            } 
        });
        
        if (response.data.errors) {
            console.error(`  - ERRO DE MUTATION GRAPHQL para fulfillment ${fulfillmentOrderId}:`, response.data.errors);
            return false;
        }

        const userErrors = response.data.data?.fulfillmentOrderMarkAsReadyForPickup?.userErrors;
        if (userErrors && userErrors.length > 0) {
            console.error(`  - ERRO (userErrors) ao marcar como pronto para retirada ${fulfillmentOrderId}:`, userErrors);
            return false;
        }
        return true;
    } catch (error) { 
        console.error(`Erro na API ao marcar como pronto para retirada ${fulfillmentOrderId}:`, error.response?.data || error.message); 
        return false; 
    }
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

// --- LÓGICA PRINCIPAL (ATUALIZADA) ---
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

        if (!shopifyOrderId) { console.warn(`- [Bling #${order.numero}] PULANDO: não possui 'numeroLoja'.`); continue; }

        console.log(`- [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrderWithFulfillments(shopifyOrderId);

        if (!shopifyOrder) { console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify.`); continue; }
        
        console.log(`  - [Bling #${order.numero}] Status atual: ${shopifyOrder.displayFulfillmentStatus}, Método de entrega: ${shopifyOrder.shippingLine?.title || 'N/A'}`);

        // Verifica se é um pedido de pickup (pela shipping line)
        const isPickupOrder = shopifyOrder.shippingLine?.title?.toLowerCase().includes('sede') || 
                             shopifyOrder.shippingLine?.title?.toLowerCase().includes('retirada') ||
                             shopifyOrder.shippingLine?.title?.toLowerCase().includes('pickup');

        if (!isPickupOrder) {
            console.log(`  - [Bling #${order.numero}] PULANDO: Não é um pedido de retirada (método: ${shopifyOrder.shippingLine?.title})`);
            continue;
        }

        let pickupFulfillments = shopifyOrder.fulfillmentOrders.edges.filter(edge => 
            edge.node.deliveryMethod?.methodType === 'PICKUP'
        );

        // Se não tem fulfillment orders de pickup, precisa criar fulfillment direto
        if (pickupFulfillments.length === 0 && shopifyOrder.displayFulfillmentStatus === 'UNFULFILLED') {
            console.log(`  - [Bling #${order.numero}] Criando fulfillment para pickup...`);
            const success = await createPickupFulfillment(shopifyOrder.id);
            
            if (!success) {
                console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao criar fulfillment para pickup.`);
                continue;
            }

            console.log(`  - ✅ [Bling #${order.numero}] Fulfillment criado com sucesso - pedido marcado como pronto para retirada.`);
            
            // Se conseguiu criar o fulfillment, pode atualizar o Bling
            const STATUS_ATENDIDO_BLING = 9;
            const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
            if (blingSuccess) {
                console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO!`);
            } else {
                console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar no Bling.`);
            }
            continue;
        }

        // Para pedidos já FULFILLED, verifica se precisa de processamento adicional
        if (shopifyOrder.displayFulfillmentStatus === 'FULFILLED') {
            console.log(`  - [Bling #${order.numero}] Pedido já está FULFILLED. Verificando se precisa marcar como pronto para retirada...`);
            
            // Se já está fulfilled mas ainda tem fulfillment orders que podem ser marcados como ready for pickup
            const fulfillmentsToProcess = pickupFulfillments.filter(edge => 
                edge.node.status !== 'READY_FOR_PICKUP' && edge.node.status !== 'PICKED_UP'
            );

            if (fulfillmentsToProcess.length === 0) {
                console.log(`  - [Bling #${order.numero}] AVISO: Pedido já processado completamente.`);
                // Mesmo assim, atualiza o Bling já que o pedido está pronto
                const STATUS_ATENDIDO_BLING = 9;
                const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
                if (blingSuccess) {
                    console.log(`  - ✅ [Bling #${order.numero}] Status atualizado no Bling para 'Atendido'.`);
                }
                continue;
            }

            // Processa fulfillment orders que ainda podem ser marcados como ready
            console.log(`  - [Bling #${order.numero}] Tentando marcar fulfillments como 'Pronto para Retirada'...`);
            let shopifySuccess = true;

            for (const fulfillmentEdge of fulfillmentsToProcess) {
                const fulfillmentOrderId = fulfillmentEdge.node.id;
                const success = await markOrderReadyForPickup(fulfillmentOrderId);
                if (!success) {
                    shopifySuccess = false;
                    console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao marcar fulfillment ${fulfillmentOrderId} como pronto.`);
                } else {
                    console.log(`  - ✅ [Bling #${order.numero}] Fulfillment ${fulfillmentOrderId} marcado como pronto para retirada.`);
                }
            }

            if (shopifySuccess) {
                console.log(`  - [Bling #${order.numero}] SUCESSO no Shopify. Atualizando Bling para 'Atendido'...`);
                const STATUS_ATENDIDO_BLING = 9;
                const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
                if (blingSuccess) {
                    console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO!`);
                } else {
                    console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar no Bling.`);
                }
            }
            continue;
        }

        // Se chegou aqui, é um caso não tratado
        console.log(`  - [Bling #${order.numero}] AVISO: Caso não tratado - Status: ${shopifyOrder.displayFulfillmentStatus}, Fulfillments: ${pickupFulfillments.length}`);
    }
    }
    console.log("============================== TAREFA FINALIZADA ==============================\n");


// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    cron.schedule("*/30 * * * * *", processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa agendada para executar a cada 30 segundos.');
});