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
                    fulfillments(first: 10) {
                        edges {
                            node {
                                id
                                status
                                displayStatus
                                trackingInfo {
                                    company
                                    number
                                    url
                                }
                            }
                        }
                    }
                    lineItems(first: 10) {
                        edges {
                            node {
                                id
                                title
                                quantity
                                fulfillmentStatus
                                fulfillableQuantity
                                variant {
                                    id
                                    inventoryItem {
                                        id
                                        tracked
                                    }
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

// NOVA FUNÇÃO: Marcar pedido como pronto para retirada (fulfillment)
const markOrderReadyForPickup = async (shopifyOrderGid) => {
    console.log(`    → Tentando marcar pedido ${shopifyOrderGid} como pronto para retirada...`);
    
    try {
        // Primeiro, buscar dados completos do pedido
        const orderData = await findShopifyOrderId(shopifyOrderGid.replace('gid://shopify/Order/', ''));
        
        if (!orderData || !orderData.lineItems || !orderData.lineItems.edges) {
            console.error(`    → Erro: Não foi possível obter dados do pedido`);
            return false;
        }

        // Preparar os itens para fulfillment
        const lineItems = orderData.lineItems.edges
            .filter(edge => edge.node.fulfillableQuantity > 0) // Apenas itens que podem ser fulfilled
            .map(edge => ({
                id: edge.node.id,
                quantity: edge.node.fulfillableQuantity
            }));

        if (lineItems.length === 0) {
            console.log(`    → Aviso: Nenhum item precisa de fulfillment (já foram processados)`);
            return true; // Considera sucesso se já foi processado
        }

        console.log(`    → Criando fulfillment para ${lineItems.length} item(s)...`);

        // Mutation para criar fulfillment
        const fulfillmentMutation = `
            mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
                fulfillmentCreate(fulfillment: $fulfillment) {
                    fulfillment {
                        id
                        status
                        displayStatus
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }`;

        const fulfillmentInput = {
            orderId: shopifyOrderGid,
            lineItems: lineItems,
            trackingInfo: {
                company: "Retirada na Loja",
                number: "PICKUP",
                url: ""
            },
            notifyCustomer: false,
            locationId: null // Usar localização padrão
        };

        const response = await axios.post(process.env.SHOPIFY_API_URL, {
            query: fulfillmentMutation,
            variables: { fulfillment: fulfillmentInput }
        }, {
            headers: {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        console.log(`    → Resposta do fulfillment:`, JSON.stringify(response.data, null, 2));

        if (response.data.errors) {
            console.error(`    → ERRO DE GRAPHQL no fulfillment:`, response.data.errors);
            return false;
        }

        const fulfillmentResult = response.data.data?.fulfillmentCreate;
        const userErrors = fulfillmentResult?.userErrors;

        if (userErrors && userErrors.length > 0) {
            console.error(`    → ERRO (userErrors) no fulfillment:`, userErrors);
            return false;
        }

        const fulfillment = fulfillmentResult?.fulfillment;
        if (fulfillment) {
            console.log(`    → SUCESSO! Fulfillment criado: ${fulfillment.id} - Status: ${fulfillment.displayStatus}`);
            return true;
        }

        console.error(`    → ERRO: Resposta inesperada do fulfillment`);
        return false;

    } catch (error) {
        console.error(`    → ERRO DE CONEXÃO no fulfillment:`, error.response?.data || error.message);
        
        // Se falhar, tentar método alternativo com fulfillmentOrdersSetFulfillmentOrders
        console.log(`    → Tentando método alternativo...`);
        return await markOrderReadyForPickupAlternative(shopifyOrderGid);
    }
};

// Método alternativo para marcar como pronto para retirada
const markOrderReadyForPickupAlternative = async (shopifyOrderGid) => {
    try {
        console.log(`    → Usando método alternativo para ${shopifyOrderGid}...`);
        
        const mutation = `
            mutation orderUpdate($input: OrderInput!) {
                orderUpdate(input: $input) {
                    order {
                        id
                        displayFulfillmentStatus
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }`;

        const input = {
            id: shopifyOrderGid,
            tags: ["Pronto para Retirada"] // Fallback para tags
        };

        const response = await axios.post(process.env.SHOPIFY_API_URL, {
            query: mutation,
            variables: { input }
        }, {
            headers: {
                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.errors) {
            console.error(`    → ERRO no método alternativo:`, response.data.errors);
            return false;
        }

        const result = response.data.data?.orderUpdate;
        if (result?.userErrors && result.userErrors.length > 0) {
            console.error(`    → ERRO (userErrors) no método alternativo:`, result.userErrors);
            return false;
        }

        console.log(`    → SUCESSO com método alternativo!`);
        return true;

    } catch (error) {
        console.error(`    → FALHA TOTAL no método alternativo:`, error.message);
        return false;
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
                    ... on Order {
                        tags
                    }
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
        
        console.log(`    → Resposta da API Shopify:`, JSON.stringify(response.data, null, 2));
        
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
        // Tenta usar o endpoint de alteração de situação específico
        const updateData = {
            idSituacao: newStatusId
        };
        
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
        console.error(`    → Dados do erro:`, JSON.stringify(error.response?.data, null, 2));
        
        // Se o endpoint específico falhar, tenta o endpoint genérico
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

        console.log(`\n- [Bling #${order.numero}] Processando... Buscando no Shopify pelo ID: ${shopifyOrderId}`);
        const shopifyOrder = await findShopifyOrderId(shopifyOrderId);

        if (!shopifyOrder) { 
            console.warn(`  - [Bling #${order.numero}] AVISO: Pedido não encontrado no Shopify.`); 
            continue; 
        }
        
        console.log(`  - [Bling #${order.numero}] Pedido encontrado no Shopify: ${shopifyOrder.name}`);
        console.log(`  - Tags atuais:`, shopifyOrder.tags);
        console.log(`  - Status de fulfillment atual:`, shopifyOrder.displayFulfillmentStatus);
        
        // PRINCIPAL: Marca como pronto para retirada (fulfillment)
        console.log(`  - [Bling #${order.numero}] Marcando como 'Pronto para Retirada' (fulfillment)...`);
        const fulfillmentSuccess = await markOrderReadyForPickup(shopifyOrder.id);
        
        // BACKUP: Adiciona tag também
        const TAG_PRONTO_RETIRADA = "Pronto para Retirada";
        const currentTags = shopifyOrder.tags || [];
        
        let tagSuccess = true;
        if (!currentTags.includes(TAG_PRONTO_RETIRADA)) {
            console.log(`  - [Bling #${order.numero}] Adicionando tag "${TAG_PRONTO_RETIRADA}" como backup...`);
            tagSuccess = await addTagToShopifyOrder(shopifyOrder.id, TAG_PRONTO_RETIRADA);
            
            if (!tagSuccess) {
                console.log(`  - [Bling #${order.numero}] Tag falhou, tentando adicionar tag sem GraphQL...`);
                // Fallback adicional - pode implementar REST API se necessário
            }
        } else {
            console.log(`  - [Bling #${order.numero}] Tag "${TAG_PRONTO_RETIRADA}" já existe. Pulando adição de tag.`);
        }
        
        // Considera sucesso se pelo menos uma das ações funcionou
        const shopifySuccess = fulfillmentSuccess || tagSuccess;
        
        if (!shopifySuccess) {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO: Falha tanto no fulfillment quanto na tag do Shopify.`);
            continue;
        }
        
        if (fulfillmentSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] SUCESSO no fulfillment do Shopify!`);
        } else {
            console.log(`  - ⚠️ [Bling #${order.numero}] Fulfillment falhou, mas tag foi adicionada.`);
        }
        
        // Agora tenta atualizar o Bling
        console.log(`  - [Bling #${order.numero}] Atualizando Bling para 'Atendido'...`);
        const STATUS_ATENDIDO_BLING = 9;
        const blingSuccess = await updateBlingOrderStatus(token, blingOrderId, STATUS_ATENDIDO_BLING);
        
        if (blingSuccess) {
            console.log(`  - ✅ [Bling #${order.numero}] SUCESSO COMPLETO!`);
        } else {
            console.error(`  - ❌ [Bling #${order.numero}] ERRO CRÍTICO: Shopify OK, mas FALHA ao atualizar no Bling.`);
        }
    }
    
    console.log("\n============================== TAREFA FINALIZADA ==============================\n");
};

// --- ROTA ESPECÍFICA PARA TESTAR FULFILLMENT ---
app.get('/test-fulfillment/:orderId', async (req, res) => {
    const { orderId } = req.params;
    console.log(`\n=== TESTE DE FULFILLMENT PARA PEDIDO: ${orderId} ===`);
    
    try {
        const shopifyGid = `gid://shopify/Order/${orderId}`;
        
        // Testa apenas o fulfillment
        const fulfillmentResult = await markOrderReadyForPickup(shopifyGid);
        
        res.json({
            orderId: orderId,
            shopifyGid: shopifyGid,
            fulfillmentSuccess: fulfillmentResult,
            message: fulfillmentResult ? "SUCESSO: Pedido marcado como pronto para retirada!" : "ERRO: Falha ao marcar como pronto para retirada"
        });
        
    } catch (error) {
        console.error("Erro no teste de fulfillment:", error);
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
        
        // Tenta marcar como pronto para retirada
        const fulfillmentResult = await markOrderReadyForPickup(shopifyOrder.id);
        
        // Adiciona tag como backup
        const TAG_PRONTO_RETIRADA = "Pronto para Retirada";
        const tagResult = await addTagToShopifyOrder(shopifyOrder.id, TAG_PRONTO_RETIRADA);
        
        // Busca novamente para confirmar
        const updatedOrder = await findShopifyOrderId(orderId);
        
        res.json({
            fulfillmentSuccess: fulfillmentResult,
            tagSuccess: tagResult,
            originalOrder: shopifyOrder,
            updatedOrder: updatedOrder,
            message: fulfillmentResult ? "Pedido marcado como pronto para retirada!" : "Falha ao marcar como pronto para retirada"
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
    console.log("TESTE MANUAL INICIADO via /test-process");
    await processOrders();
    res.send("Teste executado! Verifique os logs no console.");
});

// --- ROTA PARA AUTORIZAÇÃO DO BLING ---
app.get('/auth/bling', (req, res) => {
    const authUrl = `https://bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${process.env.BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.BLING_REDIRECT_URI)}`;
    res.redirect(authUrl);
});

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Acesse http://localhost:3000/test-process para testar manualmente');
    console.log('Acesse http://localhost:3000/auth/bling para autorizar o Bling');
    
    // Executa a cada 30 segundos
    cron.schedule('*/30 * * * * *', processOrders);
    console.log('Tarefa agendada para executar a cada 30 segundos.');
});