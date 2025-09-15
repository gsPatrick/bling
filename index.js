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

// Função de teste: Busca os 100 pedidos mais recentes sem filtros
const getRecentBlingOrdersForDebug = async (token) => {
    const url = `https://www.bling.com.br/Api/v3/pedidos/vendas`;
    try {
        const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        return response.data && response.data.data ? response.data.data : [];
    } catch (error) {
        console.error("Erro ao buscar pedidos no Bling:", error.response?.data || error.message);
        return null;
    }
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

// --- LÓGICA DE TESTE (CRON JOB) ---
const runDebug = async () => {
    console.log(`\n\n========================= [${new Date().toISOString()}] =========================`);
    console.log("INICIANDO SCRIPT DE TESTE: Captura de dados brutos do Bling.");
    
    const token = await getTokenFromCache();
    if (!token) {
        console.log("--> TESTE ABORTADO: Token do Bling não encontrado.");
        return;
    }

    const allRecentBlingOrders = await getRecentBlingOrdersForDebug(token);
    
    if (!allRecentBlingOrders) {
        console.log("--> TESTE FALHOU: Não foi possível obter dados da API do Bling.");
        return;
    }

    // ==================================================================
    // EXIBIÇÃO DOS DADOS BRUTOS NO TERMINAL
    // ==================================================================
    console.log(`--> SUCESSO! A API do Bling retornou ${allRecentBlingOrders.length} pedidos.`);
    console.log("\n--- INÍCIO DOS DADOS BRUTOS EM FORMATO JSON ---");
    
    // Usamos JSON.stringify para formatar o objeto de forma legível
    console.log(JSON.stringify(allRecentBlingOrders, null, 2));
    
    console.log("--- FIM DOS DADOS BRUTOS EM FORMATO JSON ---\n");
    console.log("============================== TESTE FINALIZADO ==============================\n");
    
    // A função para aqui e não tenta processar nada.
};

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    // Vamos rodar o teste a cada 2 minutos.
    cron.schedule('*/30 * * * * *', runDebug);
    console.log(`Servidor de TESTE rodando na porta ${PORT}`);
    console.log('Tarefa de captura de dados agendada para executar a cada 2 minutos.');
});