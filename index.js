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

// --- FUNÇÃO CORRIGIDA: marca os fulfillmentOrders como "Pronto para Retirada" ---
const markOrderAsReadyForPickup = async (shopifyOrder) => {
    try {
        console.log(`  - Iniciando processo para marcar pedido ${shopifyOrder.name} como pronto para retirada...`);
        
        // Busca fulfillment orders do tipo PICKUP
        const fulfillmentOrders = shopifyOrder.fulfillmentOrders?.edges || [];
        const pickupFulfillmentOrders = fulfillmentOrders.filter(edge => {
            const fo = edge.node;
            return fo.deliveryMethod?.methodType === 'PICKUP' && 
                   fo.status !== 'READY_FOR_PICKUP' &&
                   fo.lineItems.edges.some(li => li.node.remainingQuantity > 0);
        });

        if (pickupFulfillmentOrders.length === 0) {
            console.log(`  - ⚠️ Nenhum fulfillment order de pickup encontrado ou já está pronto para retirada.`);
            return false;
        }

        console.log(`  - Encontrados ${pickupFulfillmentOrders.length} fulfillment order(s) de pickup para processar.`);

        // Para cada fulfillment order, marca como pronto para retirada
        let successCount = 0;
        for (const foEdge of pickupFulfillmentOrders) {
            const fulfillmentOrder = foEdge.node;
            console.log(`    - Processando fulfillment order: ${fulfillmentOrder.id} (status: ${fulfillmentOrder.status})`);
            
            const mutation = `
                mutation fulfillmentOrderLineItemsPreparedForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
                    fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;

            const variables = {
                input: {
                    lineItemsByFulfillmentOrder: [
                        {
                            fulfillmentOrderId: fulfillmentOrder.id
                        }
                    ]
                }
            };

            try {
                const response = await axios.post(process.env.SHOPIFY_API_URL, {
                    query: mutation,
                    variables
                }, {
                    headers: {
                        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.data.errors) {
                    console.error(`    - ❌ Erro GraphQL:`, response.data.errors);
                    continue;
                }

                const userErrors = response.data.data?.fulfillmentOrderLineItemsPreparedForPickup?.userErrors;
                if (userErrors && userErrors.length > 0) {
                    console.error(`    - ❌ Erro ao processar fulfillment order:`, userErrors);
                    continue;
                }

                console.log(`    - ✅ Fulfillment order marcado como pronto para retirada com sucesso.`);
                successCount++;

            } catch (error) {
                console.error(`    - ❌ Erro de conexão:`, error.response?.data || error.message);
                continue;
            }
        }

        if (successCount > 0) {
            console.log(`  - ✅ ${successCount}/${pickupFulfillmentOrders.length} fulfillment order(s) marcados como pronto para retirada.`);
            return true;
        } else {
            console.log(`  - ❌ Nenhum fulfillment order foi processado com sucesso.`);
            return false;
        }

    } catch (error) {
        console.error(`  - ❌ Erro geral ao marcar como pronto para retirada:`, error.message);
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

// --- LÓGICA PRINCIPAL (CORRIGIDA) ---
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

        // Verifica se é pedido de pickup (melhor verificação)
        const hasPickupFulfillmentOrder = shopifyOrder.fulfillmentOrders?.edges?.some(edge => 
            edge.node.deliveryMethod?.methodType === 'PICKUP'
        );

        if (!hasPickupFulfillmentOrder) {
            console.log(`  - [Bling #${order.numero}] PULANDO: Não é um pedido de retirada (sem fulfillment order do tipo PICKUP)`);
            continue;
        }

        // Marca pedido como pronto para retirada
        const success = await markOrderAsReadyForPickup(shopifyOrder);

        if (!success) {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha ao marcar pedido como pronto para retirada.`);
            continue;
        }

        console.log(`  - ✅ [Bling #${order.numero}] Pedido marcado como pronto para retirada no Shopify.`);

        // Atualiza o Bling para 'Atendido'
        const STATUS_ATENDIDO_BLING = 9;
        const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);

        if (blingSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] Status atualizado no Bling para 'Atendido'.`);
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