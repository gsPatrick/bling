


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

// MAPEAMENTO DE IDs DO BLING PARA IDs DO SHOPIFY
const blingToShopifyIdMapping = {
    '2143': '5804091048247',
    // Adicione outros mapeamentos conforme necessário
    // '1234': '5678901234567',
    // '5678': '9012345678901'
};

// Busca pedido no Shopify pelo ID
const findShopifyOrderId = async (orderIdFromBling) => {
    // Verifica se existe um mapeamento específico para este ID do Bling
    let shopifyOrderId = blingToShopifyIdMapping[orderIdFromBling] || orderIdFromBling;
    
    console.log(`  - Buscando pedido Bling #${orderIdFromBling} no Shopify usando ID: ${shopifyOrderId}`);
    
    const shopifyGid = `gid://shopify/Order/${shopifyOrderId}`;
    const query = `
        query getOrderById($id: ID!) { 
            node(id: $id) { 
                ... on Order { 
                    id
                    name
                    tags
                    displayFulfillmentStatus
                    displayFinancialStatus
                    createdAt
                    lineItems(first: 50) {
                        nodes {
                            id
                            title
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
                            lineItems(first: 50) {
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
        if (orderNode && orderNode.id) {
            console.log(`  - ✅ SUCESSO: Pedido encontrado no Shopify: ${orderNode.name}`);
            return orderNode;
        } else {
            console.log(`  - ❌ AVISO: Pedido não encontrado no Shopify para o ID ${shopifyOrderId}`);
            return null;
        }
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
        const lineItems = fulfillmentOrder.lineItems?.nodes || [];
        
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
            const lineItems = fulfillmentOrder.lineItems?.nodes || [];
            
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
            
            const lineItems = fulfillmentOrder.lineItems?.nodes || [];
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
        
        const result = response.data.data?.tagsAdd;
        const userErrors = result?.userErrors || [];
        
        if (userErrors.length > 0) {
            console.error(`    → ERRO (userErrors) ao adicionar tag:`, userErrors);
            return false;
        }
        
        console.log(`    → ✅ SUCESSO! Tag "${tag}" adicionada ao pedido`);
        return true;
        
    } catch (error) { 
        console.error(`    → ERRO DE CONEXÃO ao adicionar tag:`, error.response?.data || error.message); 
        return false; 
    }
};

// --- ROTAS DA API ---

// Rota para iniciar o processo de autorização do Bling
app.get('/webhook/bling/auth', (req, res) => {
    const authUrl = `https://bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${process.env.BLING_CLIENT_ID}&state=loja_amouh`;
    res.redirect(authUrl);
});

// Rota de callback para o Bling
app.get('/webhook/bling/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Erro: Código de autorização não encontrado.");
    
    try {
        const tokenData = await getBlingToken(code);
        await saveTokenToCache(tokenData);
        res.send("Autorização com Bling concluída com sucesso! O token foi salvo.");
    } catch (error) {
        res.status(500).send("Falha ao obter ou salvar o token do Bling.");
    }
});

// Rota para testar a busca de pedidos (para debug)
app.get('/test/orders', async (req, res) => {
    const token = await getTokenFromCache();
    if (!token) return res.status(401).send("Token do Bling não encontrado. Autorize primeiro.");
    
    const statusId = 204574266; // ID para "Aguardando Retirada"
    const orders = await getBlingOrdersWithStatus(token, statusId);
    res.json(orders);
});

// --- TAREFAS AGENDADAS (CRON) ---

// Função principal que executa a lógica de negócio
const executeTask = async () => {
    console.log(`
========================= [${new Date().toISOString()}] =========================`);
    console.log("🎯 OBJETIVO: Marcar pedidos como PRONTO PARA RETIRADA");
    console.log("INICIANDO TAREFA: Verificação de pedidos 'Aguardando Retirada'.");

    const token = await getTokenFromCache();
    if (!token) {
        console.error("FALHA CRÍTICA: Token do Bling não encontrado. A tarefa não pode continuar.");
        return;
    }

    const statusId = process.env.SHOPIFY_STORE_ID_IN_BLING; // ID para "Aguardando Retirada"
    const blingOrders = await getBlingOrdersWithStatus(token, statusId);

    if (blingOrders.length === 0) {
        console.log("--> Nenhum pedido 'Aguardando Retirada' encontrado.");
        console.log("============================== TAREFA FINALIZADA ==============================");
        return;
    }

    console.log(`--> Encontrados ${blingOrders.length} pedido(s) da sua loja para processar.`);

    for (const blingOrder of blingOrders) {
        const orderIdFromBling = blingOrder.id;
        console.log(`
🔄 [Bling #${orderIdFromBling}] Processando...`);

        const shopifyOrder = await findShopifyOrderId(orderIdFromBling);

        if (!shopifyOrder) {
            console.log(`  - [Bling #${orderIdFromBling}] AVISO: Pedido não encontrado no Shopify.`);
            continue;
        }

        // Tenta marcar o pedido como pronto para retirada
        const success = await markOrderReadyForPickup(shopifyOrder);

        if (success) {
            console.log(`  - [Bling #${orderIdFromBling}] ✅ SUCESSO: Pedido marcado como PRONTO PARA RETIRADA no Shopify.`);
            // Adiciona a tag 'retirada-local-pronto' ao pedido no Shopify
            await addTagToShopifyOrder(shopifyOrder.id, 'retirada-local-pronto');
        } else {
            console.log(`  - [Bling #${orderIdFromBling}] ❌ FALHA: Não foi possível marcar o pedido como PRONTO PARA RETIRADA.`);
        }
    }

    console.log(`
🎯 RESUMO: Todos os pedidos processados foram marcados como PRONTO PARA RETIRADA`);
    console.log("============================== TAREFA FINALIZADA ==============================");
};

// Agenda a tarefa para rodar a cada 30 minutos
cron.schedule('*/30 * * * *', () => {
    executeTask();
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log("A tarefa agendada para verificar pedidos 'Aguardando Retirada' está ativa.");
    // Executa a tarefa uma vez ao iniciar para teste imediato
    executeTask();
});
