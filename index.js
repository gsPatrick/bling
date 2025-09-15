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
    const body = new URLSearchParams({ 
        grant_type: 'authorization_code', 
        code: code, 
        redirect_uri: process.env.BLING_REDIRECT_URI 
    });
    
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

const getBlingOrdersWithStatus = async (token, statusId) => {
    const url = `https://www.bling.com.br/Api/v3/pedidos/vendas?idsSituacoes[]=${statusId}`;
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

// Busca pedido no Shopify pelo ID
const findShopifyOrderId = async (orderIdFromBling) => {
    const shopifyGid = `gid://shopify/Order/${orderIdFromBling}`;
    const query = `
        query getOrderById($id: ID!) { 
            node(id: $id) { 
                ... on Order { 
                    id
                    name
                    tags
                    displayFulfillmentStatus
                    fulfillmentStatus
                    displayFinancialStatus
                    createdAt
                    lineItems(first: 50) {
                        nodes {
                            id
                            title
                            fulfillmentStatus
                            quantity
                            variant {
                                id
                                title
                            }
                            product {
                                id
                                title
                            }
                        }
                    }
                    fulfillmentOrders(first: 50) {
                        nodes {
                            id
                            status
                            requestStatus
                            fulfillmentOrderLineItems(first: 50) {
                                nodes {
                                    id
                                    lineItem {
                                        id
                                        title
                                    }
                                    remainingQuantity
                                    totalQuantity
                                }
                            }
                        }
                    }
                } 
            } 
        }`;
    const variables = { id: shopifyGid };
    
    try {
        const response = await axios.post(process.env.SHOPIFY_API_URL, { 
            query, 
            variables 
        }, { 
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

// FUNÇÃO PRINCIPAL: Cria fulfillment para pickup local (sem marcar como pronto ainda)
const createLocalPickupFulfillment = async (shopifyOrder) => {
    console.log(`    → Criando fulfillment de pickup LOCAL para pedido ${shopifyOrder.name}`);
    
    const fulfillmentOrders = shopifyOrder.fulfillmentOrders?.nodes || [];
    
    if (fulfillmentOrders.length === 0) {
        console.error(`    → ERRO: Não há fulfillment orders disponíveis para o pedido ${shopifyOrder.name}`);
        console.log(`    → Isso indica que o pedido ainda não foi processado pelo Shopify`);
        return false;
    }
    
    console.log(`    → Encontrados ${fulfillmentOrders.length} fulfillment order(s) para processar`);
    
    // Para cada fulfillment order, cria um fulfillment
    let successCount = 0;
    
    for (const fulfillmentOrder of fulfillmentOrders) {
        const lineItems = fulfillmentOrder.fulfillmentOrderLineItems?.nodes || [];
        
        if (lineItems.length === 0) {
            console.warn(`    → AVISO: Nenhum line item encontrado no fulfillment order ${fulfillmentOrder.id}`);
            continue;
        }
        
        console.log(`    → Processando fulfillment order ${fulfillmentOrder.id} com ${lineItems.length} item(s)`);
        
        // Prepara os line items para o fulfillment
        const fulfillmentOrderLineItems = lineItems.map(item => ({
            id: item.id,
            quantity: item.remainingQuantity || item.totalQuantity
        }));
        
        const mutation = `
            mutation fulfillmentCreate($fulfillment: FulfillmentV2Input!) {
                fulfillmentCreate(fulfillment: $fulfillment) {
                    fulfillment {
                        id
                        status
                        displayStatus
                        createdAt
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }`;
        
        const variables = {
            fulfillment: {
                lineItemsByFulfillmentOrder: [{
                    fulfillmentOrderId: fulfillmentOrder.id,
                    fulfillmentOrderLineItems: fulfillmentOrderLineItems
                }],
                notifyCustomer: false, // Não notifica ainda, só quando marcar como pronto
                trackingInfo: {
                    company: "Retirada Local",
                    number: `PICKUP-${shopifyOrder.name}`
                }
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
            
            console.log(`    → Resposta da API Shopify:`, JSON.stringify(response.data, null, 2));
            
            if (response.data.errors) {
                console.error(`    → ERRO DE GRAPHQL:`, response.data.errors);
                continue;
            }
            
            const result = response.data.data?.fulfillmentCreate;
            const userErrors = result?.userErrors || [];
            
            if (userErrors.length > 0) {
                console.error(`    → ERRO (userErrors):`, userErrors);
                continue;
            }
            
            const fulfillment = result?.fulfillment;
            if (fulfillment) {
                console.log(`    → ✅ SUCESSO! Fulfillment criado: ${fulfillment.id}`);
                console.log(`    → Status: ${fulfillment.status} (${fulfillment.displayStatus})`);
                successCount++;
            }
            
        } catch (error) {
            console.error(`    → ERRO DE CONEXÃO:`, error.response?.data || error.message);
            continue;
        }
    }
    
    return successCount > 0;
};

// FUNÇÃO: Marca fulfillment orders como PRONTO PARA RETIRADA
const markFulfillmentOrdersReadyForPickup = async (shopifyOrder) => {
    console.log(`    → Marcando fulfillment orders como PRONTO PARA RETIRADA para pedido ${shopifyOrder.name}`);
    
    const fulfillmentOrders = shopifyOrder.fulfillmentOrders?.nodes || [];
    
    if (fulfillmentOrders.length === 0) {
        console.error(`    → ERRO: Não há fulfillment orders para marcar como pronto`);
        return false;
    }
    
    let successCount = 0;
    
    for (const fulfillmentOrder of fulfillmentOrders) {
        console.log(`    → Processando fulfillment order: ${fulfillmentOrder.id} (status: ${fulfillmentOrder.status})`);
        
        // Verifica se pode ser marcado como pronto para retirada
        if (fulfillmentOrder.status === 'SCHEDULED' || fulfillmentOrder.status === 'OPEN') {
            const lineItems = fulfillmentOrder.fulfillmentOrderLineItems?.nodes || [];
            
            if (lineItems.length === 0) {
                console.warn(`    → AVISO: Nenhum line item encontrado no fulfillment order ${fulfillmentOrder.id}`);
                continue;
            }
            
            const preparedResult = await prepareLineItemsForPickup(fulfillmentOrder.id, lineItems);
            
            if (preparedResult) {
                successCount++;
                console.log(`    → ✅ SUCESSO: Fulfillment order ${fulfillmentOrder.id} marcado como PRONTO PARA RETIRADA`);
            } else {
                console.error(`    → ❌ ERRO: Falha ao marcar fulfillment order ${fulfillmentOrder.id} como pronto`);
            }
        } else if (fulfillmentOrder.status === 'CLOSED') {
            console.log(`    → Fulfillment order ${fulfillmentOrder.id} já foi fechado (considerando como sucesso)`);
            successCount++;
        } else {
            console.log(`    → Fulfillment order ${fulfillmentOrder.id} em status ${fulfillmentOrder.status} - tentando marcar mesmo assim...`);
            
            const lineItems = fulfillmentOrder.fulfillmentOrderLineItems?.nodes || [];
            if (lineItems.length > 0) {
                const preparedResult = await prepareLineItemsForPickup(fulfillmentOrder.id, lineItems);
                if (preparedResult) {
                    successCount++;
                    console.log(`    → ✅ SUCESSO inesperado: Fulfillment order ${fulfillmentOrder.id} marcado como PRONTO PARA RETIRADA`);
                }
            }
        }
    }
    
    return successCount > 0;
};

// FUNÇÃO: Implementa a API do Shopify para marcar como pronto para retirada
const prepareLineItemsForPickup = async (fulfillmentOrderId, lineItems) => {
    console.log(`      → Marcando ${lineItems.length} item(s) como PRONTO PARA RETIRADA no fulfillment order: ${fulfillmentOrderId}`);
    
    // Prepara os line items com suas quantidades
    const fulfillmentOrderLineItems = lineItems.map(item => ({
        id: item.id,
        quantity: item.remainingQuantity || item.totalQuantity
    }));
    
    const mutation = `
        mutation fulfillmentOrderLineItemsPreparedForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
            fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
                userErrors {
                    field
                    message
                }
            }
        }`;
    
    const variables = {
        input: {
            id: fulfillmentOrderId,
            fulfillmentOrderLineItems: fulfillmentOrderLineItems
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
        
        console.log(`      → Resposta da API Shopify:`, JSON.stringify(response.data, null, 2));
        
        if (response.data.errors) {
            console.error(`      → ERRO DE GRAPHQL:`, response.data.errors);
            return false;
        }
        
        const result = response.data.data?.fulfillmentOrderLineItemsPreparedForPickup;
        const userErrors = result?.userErrors || [];
        
        if (userErrors.length > 0) {
            console.error(`      → ERRO (userErrors):`, userErrors);
            return false;
        }
        
        console.log(`      → ✅ SUCESSO! Items marcados como PRONTO PARA RETIRADA`);
        return true;
        
    } catch (error) {
        console.error(`      → ERRO DE CONEXÃO:`, error.response?.data || error.message);
        return false;
    }
};

// FUNÇÃO PRINCIPAL CORRIGIDA: Garante que o pedido seja marcado como PRONTO PARA RETIRADA
const markOrderReadyForPickup = async (shopifyOrder) => {
    console.log(`    → OBJETIVO: Marcar pedido ${shopifyOrder.name} como PRONTO PARA RETIRADA`);
    
    const fulfillmentOrders = shopifyOrder.fulfillmentOrders?.nodes || [];
    console.log(`    → Status atual: ${shopifyOrder.displayFulfillmentStatus}`);
    console.log(`    → Fulfillment Orders encontrados: ${fulfillmentOrders.length}`);
    
    if (fulfillmentOrders.length === 0) {
        console.log(`    → PROBLEMA: Não há fulfillment orders. O pedido precisa ser processado primeiro.`);
        console.log(`    → AÇÃO: Tentando criar fulfillment de pickup local...`);
        
        // Primeira tentativa: criar fulfillment local
        const createResult = await createLocalPickupFulfillment(shopifyOrder);
        
        if (!createResult) {
            console.error(`    → ❌ FALHA: Não conseguiu criar fulfillment local`);
            return false;
        }
        
        console.log(`    → ✅ Fulfillment local criado com sucesso!`);
        
        // Busca o pedido novamente para pegar os novos fulfillment orders
        console.log(`    → Buscando pedido atualizado...`);
        const updatedOrder = await findShopifyOrderId(shopifyOrder.id.split('/').pop());
        
        if (!updatedOrder || !updatedOrder.fulfillmentOrders?.nodes?.length) {
            console.error(`    → ❌ PROBLEMA: Mesmo após criar fulfillment, não há fulfillment orders`);
            return false;
        }
        
        // Agora marca como pronto para retirada
        return await markFulfillmentOrdersReadyForPickup(updatedOrder);
    } else {
        // Já há fulfillment orders, marca diretamente como pronto para retirada
        console.log(`    → AÇÃO: Marcando fulfillment orders existentes como PRONTO PARA RETIRADA`);
        return await markFulfillmentOrdersReadyForPickup(shopifyOrder);
    }
};

// FUNÇÃO CORRIGIDA: Adiciona uma tag ao pedido
const addTagToShopifyOrder = async (shopifyGid, tag) => {
    console.log(`    → Tentando adicionar tag "${tag}" ao pedido ${shopifyGid}`);
    
    const mutation = `
        mutation tagsAdd($id: ID!, $tags: [String!]!) { 
            tagsAdd(id: $id, tags: $tags) { 
                node { 
                    id
                    tags
                }
                userErrors { 
                    field
                    message 
                } 
            } 
        }`;
    
    const variables = { id: shopifyGid, tags: [tag] };
    
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
            console.error(`    → ERRO DE GRAPHQL ao adicionar tag:`, response.data.errors);
            return false;
        }
        
        const tagsAddResult = response.data.data?.tagsAdd;
        const userErrors = tagsAddResult?.userErrors;
        
        if (userErrors && userErrors.length > 0) {
            console.error(`    → ERRO (userErrors) ao adicionar tag ao pedido ${shopifyGid}:`, userErrors);
            return false;
        }
        
        const updatedTags = tagsAddResult?.node?.tags || [];
        console.log(`    → SUCESSO! Tags atuais do pedido:`, updatedTags);
        
        return true;
    } catch (error) { 
        console.error(`    → ERRO DE CONEXÃO ao adicionar tag ao pedido ${shopifyGid}:`, error.response?.data || error.message); 
        return false; 
    }
};

// FUNÇÃO MELHORADA: Atualiza status do pedido no Bling
const updateBlingOrderStatus = async (token, blingOrderId, newStatusId) => {
    console.log(`    → Tentando atualizar pedido ${blingOrderId} para status ${newStatusId} no Bling`);
    
    try {
        // Primeiro, busca os dados completos do pedido
        const getResponse = await axios.get(
            `https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`,
            { 
                headers: { 
                    'Authorization': `Bearer ${token}` 
                } 
            }
        );
        
        if (!getResponse.data || !getResponse.data.data) {
            console.error(`    → Erro ao buscar dados do pedido ${blingOrderId}`);
            return false;
        }
        
        const orderData = getResponse.data.data;
        console.log(`    → Dados atuais do pedido: Status atual = ${orderData.situacao?.id}`);
        
        // Prepara dados mínimos necessários para a atualização
        const updateData = {
            idSituacao: newStatusId
        };
        
        // Tenta usar o endpoint de alteração de situação específico
        const alteracaoResponse = await axios.put(
            `https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}/situacoes`,
            updateData,
            { 
                headers: { 
                    'Authorization': `Bearer ${token}`, 
                    'Content-Type': 'application/json' 
                } 
            }
        );
        
        console.log(`    → SUCESSO! Pedido ${blingOrderId} atualizado no Bling`);
        return true;
        
    } catch (error) { 
        console.error(`    → ERRO DETALHADO ao atualizar pedido ${blingOrderId} no Bling:`);
        console.error(`    → Status HTTP:`, error.response?.status);
        console.error(`    → URL tentada:`, error.config?.url);
        console.error(`    → Dados do erro:`, JSON.stringify(error.response?.data, null, 2));
        
        // Se o endpoint específico falhar, tenta o endpoint genérico com dados mínimos
        if (error.response?.status === 404 || error.response?.status === 405) {
            console.log(`    → Tentando endpoint alternativo...`);
            
            try {
                const alternativeResponse = await axios.patch(
                    `https://www.bling.com.br/Api/v3/pedidos/vendas/${blingOrderId}`,
                    { situacao: { id: newStatusId } },
                    { 
                        headers: { 
                            'Authorization': `Bearer ${token}`, 
                            'Content-Type': 'application/json' 
                        } 
                    }
                );
                
                console.log(`    → SUCESSO com endpoint alternativo!`);
                return true;
                
            } catch (altError) {
                console.error(`    → Endpoint alternativo também falhou:`, altError.response?.data);
                return false;
            }
        }
        
        return false; 
    }
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
    } catch (error) { 
        res.status(500).send("Falha ao processar a autenticação do Bling."); 
    }
});

// --- LÓGICA PRINCIPAL (MELHORADA) ---
const processOrders = async () => {
    console.log(`\n========================= [${new Date().toISOString()}] =========================`);
    console.log("🎯 OBJETIVO: Marcar pedidos como PRONTO PARA RETIRADA");
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

        console.log(`\n🔄 [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrderId(shopifyOrderId);

        if (!shopifyOrder) { 
            console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify.`); 
            continue; 
        }
        
        console.log(`  - [Bling #${order.numero}] Pedido encontrado no Shopify: ${shopifyOrder.name}`);
        console.log(`  - Status atual: ${shopifyOrder.displayFulfillmentStatus}`);
        console.log(`  - Tags atuais:`, shopifyOrder.tags);
        console.log(`  - Fulfillment Orders: ${shopifyOrder.fulfillmentOrders?.nodes?.length || 0}`);
        
        // PRINCIPAL: Marca como PRONTO PARA RETIRADA
        console.log(`  - [Bling #${order.numero}] 🎯 MARCANDO COMO PRONTO PARA RETIRADA...`);
        const pickupSuccess = await markOrderReadyForPickup(shopifyOrder);
        
        // BACKUP: Adiciona tag também
        const TAG_PRONTO_RETIRADA = "Pronto para Retirada";
        const currentTags = shopifyOrder.tags || [];
        
        let tagSuccess = true;
        if (!currentTags.includes(TAG_PRONTO_RETIRADA)) {
            console.log(`  - [Bling #${order.numero}] Adicionando tag "${TAG_PRONTO_RETIRADA}" como backup...`);
            tagSuccess = await addTagToShopifyOrder(shopifyOrder.id, TAG_PRONTO_RETIRADA);
        } else {
            console.log(`    → Tag "${TAG_PRONTO_RETIRADA}" já existe`);
        }
        
        // Considera sucesso se pelo menos uma das ações funcionou
        const shopifySuccess = pickupSuccess || tagSuccess;
        
        if (!shopifySuccess) {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Falha tanto no PICKUP quanto na tag do Shopify.`);
            continue;
        }
        
        if (pickupSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] SUCESSO! Pedido marcado como PRONTO PARA RETIRADA no Shopify!`);
        } else {
            console.log(`  - ⚠️ [Bling #${order.numero}] PICKUP falhou, mas tag foi adicionada como backup.`);
        }
        
        // Agora tenta atualizar o Bling
        console.log(`  - [Bling #${order.numero}] Atualizando Bling para 'Atendido'...`);
        const STATUS_ATENDIDO_BLING = 9;
        const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
        
        if (blingSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO! 🎉`);
        } else {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO: Shopify OK, mas FALHA ao atualizar no Bling.`);
        }
    }
    
    console.log("\n🎯 RESUMO: Todos os pedidos processados foram marcados como PRONTO PARA RETIRADA");
    console.log("============================== TAREFA FINALIZADA ==============================\n");
};

// --- ROTA ESPECÍFICA PARA TESTAR PICKUP ---
app.get('/test-pickup/:orderId', async (req, res) => {
    const { orderId } = req.params;
    console.log(`\n🎯 === TESTE DE PICKUP (PRONTO PARA RETIRADA) PARA PEDIDO: ${orderId} ===`);
    
    try {
        // Busca o pedido completo primeiro
        const shopifyOrder = await findShopifyOrderId(orderId);
        
        if (!shopifyOrder) {
            return res.json({ 
                error: "Pedido não encontrado no Shopify",
                orderId: orderId 
            });
        }
        
        console.log("=== DADOS DO PEDIDO ===");
        console.log("Name:", shopifyOrder.name);
        console.log("Fulfillment Status:", shopifyOrder.displayFulfillmentStatus);
        console.log("Line Items:", shopifyOrder.lineItems?.nodes?.length || 0);
        console.log("Fulfillment Orders:", shopifyOrder.fulfillmentOrders?.nodes?.length || 0);
        
        // Testa o pickup
        const pickupResult = await markOrderReadyForPickup(shopifyOrder);
        
        res.json({
            orderId: orderId,
            shopifyGid: shopifyOrder.id,
            orderName: shopifyOrder.name,
            currentStatus: shopifyOrder.displayFulfillmentStatus,
            lineItemsCount: shopifyOrder.lineItems?.nodes?.length || 0,
            fulfillmentOrdersCount: shopifyOrder.fulfillmentOrders?.nodes?.length || 0,
            fulfillmentOrders: shopifyOrder.fulfillmentOrders?.nodes || [],
            pickupSuccess: pickupResult,
            message: pickupResult ? "✅ SUCESSO: Pedido marcado como PRONTO PARA RETIRADA!" : "❌ ERRO: Falha ao marcar como PRONTO PARA RETIRADA"
        });
        
    } catch (error) {
        console.error("Erro no teste de pickup:", error);
        res.json({ error: error.message });
    }
});

// --- ROTA DE TESTE PARA UM PEDIDO ESPECÍFICO ---
app.get('/test-order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    console.log(`\n=== TESTE ESPECÍFICO PARA PEDIDO SHOPIFY: ${orderId} ===`);
    
    try {
        // Busca o pedido no Shopify
        const shopifyOrder = await findShopifyOrderId(orderId);
        
        if (!shopifyOrder) {
            return res.json({ 
                error: "Pedido não encontrado no Shopify",
                orderId: orderId 
            });
        }
        
        console.log("PEDIDO ENCONTRADO:", JSON.stringify(shopifyOrder, null, 2));
        
        // Tenta marcar como PRONTO PARA RETIRADA
        const pickupResult = await markOrderReadyForPickup(shopifyOrder);
        
        // Adiciona tag como backup
        const TAG_PRONTO_RETIRADA = "Pronto para Retirada";
        const tagResult = await addTagToShopifyOrder(shopifyOrder.id, TAG_PRONTO_RETIRADA);
        
        // Busca novamente para confirmar
        const updatedOrder = await findShopifyOrderId(orderId);
        
        res.json({
            pickupSuccess: pickupResult,
            tagSuccess: tagResult,
            originalOrder: shopifyOrder,
            updatedOrder: updatedOrder,
            message: pickupResult ? "✅ Pedido marcado como PRONTO PARA RETIRADA!" : "⚠️ Falha no pickup, mas tag foi adicionada"
        });
        
    } catch (error) {
        console.error("Erro no teste:", error);
        res.json({ error: error.message });
    }
});

// --- ROTA PARA VERIFICAR PEDIDO ---
app.get('/check-order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const shopifyOrder = await findShopifyOrderId(orderId);
        res.json({
            found: !!shopifyOrder,
            order: shopifyOrder
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// --- ROTA DE TESTE MANUAL ---
app.get('/test-process', async (req, res) => {
    console.log("🎯 TESTE MANUAL INICIADO via /test-process");
    await processOrders();
    res.send("✅ Teste executado! Verifique os logs no console para ver se os pedidos foram marcados como PRONTO PARA RETIRADA.");
});

// --- ROTA PARA TESTAR CRIAÇÃO DE FULFILLMENT LOCAL ---
app.get('/test-create-local-fulfillment/:orderId', async (req, res) => {
    const { orderId } = req.params;
    console.log(`\n=== TESTE DE CRIAÇÃO DE FULFILLMENT LOCAL PARA PEDIDO: ${orderId} ===`);
    
    try {
        const shopifyOrder = await findShopifyOrderId(orderId);
        
        if (!shopifyOrder) {
            return res.json({ 
                error: "Pedido não encontrado no Shopify",
                orderId: orderId 
            });
        }
        
        // Força a criação de um fulfillment local
        const createResult = await createLocalPickupFulfillment(shopifyOrder);
        
        res.json({
            orderId: orderId,
            orderName: shopifyOrder.name,
            createResult: createResult,
            fulfillmentOrders: shopifyOrder.fulfillmentOrders?.nodes || [],
            message: createResult ? "✅ SUCESSO: Fulfillment local criado!" : "❌ ERRO: Falha ao criar fulfillment local"
        });
        
    } catch (error) {
        console.error("Erro no teste de criação de fulfillment local:", error);
        res.json({ error: error.message });
    }
});

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log('🎯 FOCO: Marcar pedidos como PRONTO PARA RETIRADA');
    console.log('');
    console.log('📍 Rotas disponíveis:');
    console.log('  • GET /test-process - Executa processo completo');
    console.log('  • GET /test-pickup/{orderId} - Testa pickup para pedido específico');
    console.log('  • GET /test-order/{orderId} - Teste completo de um pedido');
    console.log('  • GET /check-order/{orderId} - Verifica dados de um pedido');
    console.log('  • GET /test-create-local-fulfillment/{orderId} - Força criação de fulfillment local');
    console.log('');
    
    // Executa a cada 30 segundos para testes (ajuste conforme necessário)
    cron.schedule('*/30 * * * * *', processOrders);
    console.log('⏰ Tarefa agendada para executar a cada 30 segundos.');
    console.log('🎯 OBJETIVO: Todos os pedidos "Aguardando Retirada" serão marcados como PRONTO PARA RETIRADA');
});