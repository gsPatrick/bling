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


// --- NOVA FUNÇÃO: marca os fulfillmentOrders do pedido como "Pronto para Retirada" ---
const prepareOrderForPickup = async (orderId) => {
  // Query: busca fulfillmentOrders + deliveryMethod + line items (remainingQuantity)
  const query = `
    query getFulfillmentOrders($id: ID!) {
      node(id: $id) {
        ... on Order {
          id
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

  try {
    const orderResp = await axios.post(process.env.SHOPIFY_API_URL, {
      query,
      variables: { id: orderId }
    }, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (orderResp.data.errors) {
      console.error(`  - ERRO ao buscar fulfillmentOrders do pedido ${orderId}:`, orderResp.data.errors);
      return false;
    }

    const edges = orderResp.data.data.node?.fulfillmentOrders?.edges || [];
    // filtra apenas fulfillmentOrders do tipo PICKUP com items restante (>0)
    const pickupFulfillmentOrders = edges
      .filter(e => e.node.deliveryMethod?.methodType === 'PICKUP')
      .filter(e => (e.node.lineItems.edges || []).some(li => li.node.remainingQuantity > 0))
      .map(e => ({ fulfillmentOrderId: e.node.id }));

    if (pickupFulfillmentOrders.length === 0) {
      console.log(`  - AVISO: Nenhum fulfillmentOrder de pickup com itens fulfillable no pedido ${orderId}`);
      return false;
    }

    // Mutation oficial para marcar como "Ready For Pickup"
    const mutation = `
        mutation fulfillmentOrderLineItemsPreparedForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
        fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
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

    const variables = {
      input: {
        lineItemsByFulfillmentOrder: pickupFulfillmentOrders
        // se quiser marcar itens específicos, cada entry pode incluir "fulfillmentOrderLineItems": [{ id, quantity }]
      }
    };

    const prepResp = await axios.post(process.env.SHOPIFY_API_URL, {
      query: mutation,
      variables
    }, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (prepResp.data.errors) {
      console.error(`  - ERRO ao marcar como pronto para retirada ${orderId}:`, prepResp.data.errors);
      return false;
    }

    const userErrors = prepResp.data.data?.fulfillmentOrderLineItemsPreparedForPickup?.userErrors;
    if (userErrors && userErrors.length > 0) {
      console.error(`  - ERRO (userErrors) ao marcar como pronto para retirada ${orderId}:`, userErrors);
      return false;
    }

    console.log(`  - ✅ Pedido ${orderId} marcado como PRONTO PARA RETIRADA.`);
    return true;

  } catch (err) {
    console.error(`  - ERRO de conexão ao marcar como pronto para retirada ${orderId}:`, err.response?.data || err.message);
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

async function markOrderAsReadyForPickup(orderId) {
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
}



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
async function processOrders(blingOrders) {
  console.log("========================= [", new Date().toISOString(), "] =========================");
  console.log("INICIANDO TAREFA: Verificação de pedidos 'Aguardando Retirada'.");

  for (const order of blingOrders) {
    try {
      console.log(`- [Bling #${order.id}] Processando... Buscando no Shopify pelo ID: ${order.shopifyId}`);

      // 1️⃣ Buscar o pedido no Shopify para pegar fulfillmentOrders
      const fulfillmentOrdersResponse = await shopifyGraphQL(`
        query getFulfillmentOrders($id: ID!) {
          order(id: $id) {
            id
            fulfillmentOrders {
              id
              status
              lineItems {
                id
                quantity
              }
              deliveryMethod {
                __typename
              }
            }
          }
        }
      `, { id: `gid://shopify/Order/${order.shopifyId}` });

      const fulfillmentOrders = fulfillmentOrdersResponse.data.order.fulfillmentOrders;

      if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
        console.log(`  - [Bling #${order.id}] AVISO: Pedido sem fulfillmentOrders. Pulando...`);
        continue;
      }

      for (const fo of fulfillmentOrders) {
        // Verificar se é pickup
        if (fo.deliveryMethod?.__typename !== 'Pickup') {
          console.log(`  - [Bling #${order.id}] PULANDO: Não é um pedido de retirada (método: ${fo.deliveryMethod?.__typename || 'undefined'})`);
          continue;
        }

        // 2️⃣ Preparar todos os itens para pickup
        const lineItemsInput = fo.lineItems.map(li => ({
          id: li.id,
          quantity: li.quantity
        }));

        const prepareResponse = await shopifyGraphQL(`
          mutation fulfillmentOrderLineItemsPreparedForPickup($id: ID!, $lineItems: [FulfillmentOrderLineItemInput!]!) {
            fulfillmentOrderLineItemsPreparedForPickup(id: $id, lineItems: $lineItems) {
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
        `, { id: fo.id, lineItems: lineItemsInput });

        if (prepareResponse.data.fulfillmentOrderLineItemsPreparedForPickup.userErrors.length > 0) {
          console.log(`  - ❌ [Bling #${order.id}] ERRO ao preparar itens para pickup:`, prepareResponse.data.fulfillmentOrderLineItemsPreparedForPickup.userErrors);
          continue;
        }

        // 3️⃣ Marcar o fulfillmentOrder como pronto para pickup
        const markReadyResponse = await shopifyGraphQL(`
          mutation fulfillmentOrderMarkReadyForPickup($id: ID!) {
            fulfillmentOrderMarkReadyForPickup(id: $id) {
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
        `, { id: fo.id });

        if (markReadyResponse.data.fulfillmentOrderMarkReadyForPickup.userErrors.length > 0) {
          console.log(`  - ❌ [Bling #${order.id}] ERRO ao marcar como pronto para retirada:`, markReadyResponse.data.fulfillmentOrderMarkReadyForPickup.userErrors);
          continue;
        }

        console.log(`  - ✅ [Bling #${order.id}] Pedido pronto para pickup no Shopify.`);
      }
    } catch (error) {
      console.log(`  - ❌ [Bling #${order.id}] ERRO inesperado:`, error.message);
    }
  }

  console.log("============================== TAREFA FINALIZADA ==============================");
}


    console.log("============================== TAREFA FINALIZADA ==============================\n");


    

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    cron.schedule("*/30 * * * * *", processOrders);
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Tarefa agendada para executar a cada 30 segundos.');
});