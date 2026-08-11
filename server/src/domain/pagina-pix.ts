// Página pública do PIX (Jorge, 10/08) — HTML server-rendered, autocontido
// (CSS/JS inline, logo em data URI, ZERO asset de terceiro: nada de CDN nem
// Google Fonts, pra CSP travada e nenhum vazamento de IP do cliente).
// Nasceu de 3 clientes no MESMO dia travadas em copiar o código certo no
// WhatsApp (Maria, Beatriz, Vanessa): aqui o código é um toque.
// Estados: vivo (timer + código + botão) / pago / expirado. A própria página
// consulta /pix/:token/status a cada 15s (só com a aba visível) e vira
// 'pago' sozinha se o webhook da Pagar.me confirmar com ela aberta.
import type { WaUpsellRow } from './tipos.js';

export type EstadoPagina = 'vivo' | 'pago' | 'expirado';

// O link morre depois disso (Jorge, 10/08: "o ideal seria matar o link em 7
// dias"). Dupla proteção: a rota já ignora token velho E o sweeper zera a
// coluna — quem entrar depois vê a página padrão, sem dado nenhum.
export const PAGINA_PIX_RETENCAO_DIAS = 7;

// Mesma régua do resto do funil: 'pago' vence sempre; vivo exige código
// presente E validade no futuro; qualquer outra combinação é expirado.
export function estadoPagina(row: Pick<WaUpsellRow, 'status' | 'etapa' | 'pix_codigo' | 'pix_expira_em'>): EstadoPagina {
  if (row.etapa === 'pago') return 'pago';
  if (
    row.status === 'open' &&
    row.etapa === 'pix_enviado' &&
    row.pix_codigo &&
    row.pix_expira_em &&
    new Date(row.pix_expira_em) > new Date()
  ) {
    return 'vivo';
  }
  return 'expirado';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type DadosPagina = {
  estado: EstadoPagina;
  token: string;
  nome: string; // primeiro nome, pode ser ''
  produto: string;
  preco: string; // "19,91"
  precoDe: string; // "" quando não tem DE
  economia: string; // "" quando não tem DE
  descontoPct: string; // "" quando não tem DE
  codigo: string; // '' fora do estado vivo (nunca vaza código morto)
  expiraEmIso: string; // '' fora do estado vivo
};

// Logo oficial (PNG do CDN da hidrabene.com.br, embutida — aprovada pelo Jorge)
const LOGO_B64 =
  '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';

// prettier-ignore
export function renderPaginaPix(d: DadosPagina): string {
  const nome = escapeHtml(d.nome || '');
  const produto = escapeHtml(d.produto);
  const codigo = escapeHtml(d.codigo);
  const temDe = Boolean(d.precoDe);
  const vivo = d.estado === 'vivo';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Seu Ticket Dourado · Hidrabene</title>
<style>
:root{
  --rosa-fundo:#f7ddd6; --rosa-medio:#f0c4ba; --rosa-escuro:#8a4a3d;
  --ouro-1:#f7e7b0; --ouro-2:#ddb84a; --ouro-3:#b8912a; --ouro-txt:#6b5210;
  --tinta:#2b1d16; --branco:#fffdf8; --verde:#1e7d51;
  --sans:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,'Times New Roman',serif;
  --mono:ui-monospace,'SF Mono',Consolas,monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  font-family:var(--sans); color:var(--tinta); min-height:100dvh;
  background:
    radial-gradient(120% 60% at 80% -10%, #fbe9e2 0%, transparent 60%),
    radial-gradient(100% 50% at 10% 100%, #eec2b5 0%, transparent 55%),
    linear-gradient(165deg, var(--rosa-fundo) 0%, var(--rosa-medio) 100%);
  padding-bottom:28px;
}
body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.35;mix-blend-mode:soft-light;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E");}
.pagina{max-width:430px;margin:0 auto;padding:22px 18px 0;position:relative}
.marca{display:flex;justify-content:center;margin-bottom:6px}
.marca img{filter:drop-shadow(0 1px 2px rgba(138,74,61,.25))}
.ola{text-align:center;font-family:var(--serif);font-size:17px;color:var(--rosa-escuro);margin:10px 0 2px}
.ola b{font-weight:900}
.timer-wrap{text-align:center;margin:10px 0 14px}
.timer-rotulo{font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--rosa-escuro);opacity:.85}
.timer{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:52px;font-weight:700;
  line-height:1.05;color:var(--tinta);letter-spacing:.02em}
.timer.urgente{color:#b3362a;animation:pulsa 1s ease-in-out infinite}
@keyframes pulsa{50%{opacity:.55}}
.cupom{position:relative;border-radius:16px;padding:24px 22px 20px;transform:rotate(-.8deg);
  background:linear-gradient(135deg,var(--ouro-1) 0%,#ecd07f 34%,var(--ouro-2) 62%,var(--ouro-3) 100%);
  box-shadow:0 18px 40px -18px rgba(107,63,32,.55), 0 4px 12px -6px rgba(107,63,32,.35);
  animation:chega .55s cubic-bezier(.2,.9,.3,1.2) both}
@keyframes chega{from{opacity:0;transform:rotate(-.8deg) translateY(18px) scale(.97)}}
.cupom::after{content:'';position:absolute;inset:7px;border:1.5px solid rgba(255,253,240,.75);
  border-radius:11px;pointer-events:none}
.cupom::before{content:'';position:absolute;top:0;bottom:0;left:-7px;right:-7px;pointer-events:none;
  background:
    radial-gradient(circle at left  center, var(--rosa-fundo) 6px, transparent 6.5px) left  center/14px 26px repeat-y,
    radial-gradient(circle at right center, var(--rosa-medio) 6px, transparent 6.5px) right center/14px 26px repeat-y;}
.cupom h1{font-family:var(--serif);font-weight:900;font-size:24px;line-height:1.12;text-align:center;
  color:var(--tinta);letter-spacing:-.01em;margin-bottom:4px}
.cupom .sub{font-family:var(--serif);text-align:center;font-size:14.5px;color:var(--ouro-txt);margin-bottom:14px}
.preco{display:flex;align-items:baseline;justify-content:center;gap:10px;margin-bottom:4px}
.preco .de{font-size:15px;color:#7a5c17;text-decoration:line-through;text-decoration-thickness:2px;text-decoration-color:#b3362a}
.preco .por{font-family:var(--serif);font-weight:900;font-size:40px;letter-spacing:-.02em}
.selo{display:flex;justify-content:center;margin-bottom:6px}
.selo span{background:var(--tinta);color:var(--ouro-1);font-weight:700;font-size:12.5px;
  padding:4px 14px;border-radius:99px;letter-spacing:.06em}
.beneficio{text-align:center;font-size:13px;font-weight:600;color:#5c4712}
.codigo-wrap{margin:18px 2px 0;background:var(--branco);border-radius:14px;padding:14px 16px 14px;
  box-shadow:0 8px 24px -14px rgba(107,63,32,.4)}
.codigo-rotulo{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9b8358;margin-bottom:6px}
.codigo{font-family:var(--mono);font-size:12.5px;line-height:1.55;color:#54606e;
  word-break:break-all;user-select:all;-webkit-user-select:all;cursor:pointer;
  background:#f6f4ee;border:1.5px dashed #d8cdb4;border-radius:10px;padding:10px 12px;
  transition:background .15s,border-color .15s}
.codigo:active{background:#efe9db}
.codigo.flash{background:#dff3e8;border-color:#4eb37f}
#copiarInline{width:100%;border:0;cursor:pointer;border-radius:14px;padding:17px 16px;margin-top:10px;
  font-family:var(--sans);font-weight:700;font-size:17px;letter-spacing:.02em;color:var(--tinta);
  background:linear-gradient(135deg,var(--ouro-1),var(--ouro-2) 55%,var(--ouro-3));
  box-shadow:0 10px 22px -10px rgba(148,110,26,.6), inset 0 1.5px 0 rgba(255,255,255,.65);
  transition:transform .12s ease}
#copiarInline:active{transform:scale(.97)}
#copiarInline.copiado{background:linear-gradient(135deg,#d9f2e4,#8fd8b2 60%,#4eb37f);color:#0c3f27}
#copiarInline:disabled{background:#d9cfc9;color:#8b7f78;box-shadow:none;cursor:default}
.pos-copia{text-align:center;font-size:13px;font-weight:600;color:var(--verde);margin-top:8px;
  opacity:0;transition:opacity .25s}
.pos-copia.mostra{opacity:1}
.passos{margin:20px 4px 8px;display:grid;gap:10px}
.passo{display:flex;gap:12px;align-items:flex-start}
.passo i{flex:none;width:26px;height:26px;border-radius:50%;background:var(--tinta);color:var(--ouro-1);
  font-style:normal;font-weight:700;font-size:13px;display:grid;place-items:center;margin-top:1px}
.passo p{font-size:14px;line-height:1.45}
.confianca{text-align:center;font-size:12px;color:var(--rosa-escuro);opacity:.9;margin:18px 12px 8px;line-height:1.6}
body.pago .timer-wrap,body.pago .codigo-wrap,body.pago .passos{display:none}
body.pago .cupom{transform:rotate(0)}
.pago-msg{display:none;margin:16px 6px 0;background:#eafaf1;border-left:4px solid var(--verde);
  border-radius:0 12px 12px 0;padding:16px 18px;font-size:14.5px;line-height:1.55;
  box-shadow:0 8px 24px -14px rgba(30,125,81,.35);animation:chega .5s ease both}
body.pago .pago-msg{display:block}
.pago-msg .titulo{font-family:var(--serif);font-weight:900;font-size:19px;color:var(--verde);margin-bottom:6px}
body.expirado .cupom{filter:grayscale(.85) brightness(.96);transform:rotate(0)}
body.expirado .timer{color:#8b7f78}
.expirado-msg{display:none;margin:16px 6px 0;background:#fff;border-left:4px solid var(--rosa-escuro);
  border-radius:0 12px 12px 0;padding:14px 16px;font-size:14px;line-height:1.5;
  box-shadow:0 8px 24px -14px rgba(107,63,32,.35)}
body.expirado .expirado-msg{display:block}
body.expirado .codigo-wrap,body.expirado .passos,body.expirado .timer-wrap{display:none}
</style>
</head>
<body class="${d.estado === 'vivo' ? '' : d.estado}" data-expira="${escapeHtml(d.expiraEmIso)}" data-token="${escapeHtml(d.token)}">
<main class="pagina">
  <div class="marca"><img src="data:image/png;base64,${LOGO_B64}" alt="Hidrabene" style="height:34px;width:auto"></div>
  <p class="ola">${nome ? `Oi, <b>${nome}</b>! ` : ''}Seu ticket está reservado ✨</p>

  <div class="timer-wrap">
    <div class="timer-rotulo">esta oferta expira em</div>
    <div class="timer" id="timer">--:--</div>
  </div>

  <section class="cupom">
    <h1>TICKET DOURADO</h1>
    <p class="sub">${produto}</p>
    <div class="preco">
      ${temDe ? `<span class="de">R$ ${escapeHtml(d.precoDe)}</span>` : ''}
      <span class="por">R$ ${escapeHtml(d.preco)}</span>
    </div>
    ${temDe ? `<div class="selo"><span>${escapeHtml(d.descontoPct)}% OFF · você economiza R$ ${escapeHtml(d.economia)}</span></div>` : ''}
    <p class="beneficio">Entra no MESMO pedido, sem nenhum frete a mais 📦</p>
  </section>

  <div class="codigo-wrap">
    <div class="codigo-rotulo">Código PIX copia e cola</div>
    <div class="codigo" id="codigo" title="Toque para copiar">${codigo}</div>
    <button id="copiarInline">COPIAR CÓDIGO PIX</button>
    <div class="pos-copia" id="posCopia">✅ Copiado! Agora abre o app do seu banco</div>
  </div>

  <div class="passos">
    <div class="passo"><i>1</i><p><b>Toque no botão dourado</b> — o código inteiro é copiado sozinho.</p></div>
    <div class="passo"><i>2</i><p><b>Abra o app do seu banco</b> e escolha <b>PIX Copia e Cola</b>.</p></div>
    <div class="passo"><i>3</i><p><b>Cole e confirme.</b> Entra no seu pedido na hora. 🏆</p></div>
  </div>

  <div class="pago-msg">
    <div class="titulo">🎉 Pagamento confirmado!</div>
    Seu Ticket Dourado está garantido${nome ? `, <b>${nome}</b>` : ''}. 🏆<br>
    O <b>${produto}</b> entra no <b>MESMO pedido</b> que você já fez — sem
    nenhum frete a mais. O código de rastreio chega no seu WhatsApp. 💛
  </div>

  <div class="expirado-msg">
    <b>Essa oferta encerrou.</b><br>
    Fica tranquila: seu pedido original está confirmado e segue normal — o código de
    rastreio chega no seu WhatsApp. 💛
  </div>

  <p class="confianca">🔒 Pagamento seguro processado pela Pagar.me<br>Qualquer dúvida, é só responder nossa conversa no WhatsApp</p>
</main>

<script>
(function(){
  var token = document.body.dataset.token;
  var vivo = ${vivo ? 'true' : 'false'};
  var timerEl = document.getElementById('timer');
  var btn = document.getElementById('copiarInline');

  function expirar(){
    document.body.classList.remove('pago');
    document.body.classList.add('expirado');
    if (btn){ btn.disabled = true; btn.textContent = 'OFERTA ENCERRADA'; }
  }
  function pagar(){
    document.body.classList.remove('expirado');
    document.body.classList.add('pago');
    if (btn){ btn.disabled = true; btn.textContent = '✅ PAGAMENTO CONFIRMADO'; }
  }

  if (vivo) {
    // Timer com a hora REAL de expiração vinda do servidor (data-expira)
    var expira = new Date(document.body.dataset.expira).getTime();
    var iv = setInterval(tick, 250);
    function tick(){
      var s = Math.max(0, Math.floor((expira - Date.now())/1000));
      var m = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
      timerEl.textContent = m + ':' + ss;
      if (s <= 180) timerEl.classList.add('urgente');
      if (s === 0) { clearInterval(iv); expirar(); }
    }
    tick();

    // Copiar: botão ou o próprio código — com fallback pra WebView antiga
    var copiou = false;
    function copiarCodigo(){
      var el = document.getElementById('codigo');
      var codigo = el.textContent.trim();
      function feito(){
        el.classList.add('flash');
        btn.classList.add('copiado'); btn.textContent = '✅ CÓDIGO COPIADO';
        document.getElementById('posCopia').classList.add('mostra');
        if (navigator.vibrate) navigator.vibrate(40);
        setTimeout(function(){
          el.classList.remove('flash');
          btn.classList.remove('copiado'); btn.textContent = 'COPIAR CÓDIGO PIX';
        }, 4000);
        if (!copiou) { copiou = true; try { navigator.sendBeacon('/pix/' + token + '/copiou'); } catch(e){} }
      }
      function fallback(){
        var ta = document.createElement('textarea');
        ta.value = codigo; ta.style.position='fixed'; ta.style.opacity='0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); feito(); } catch(e){ alert('Segure no código e escolha Copiar'); }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(codigo).then(feito, fallback);
      else fallback();
    }
    btn.addEventListener('click', copiarCodigo);
    document.getElementById('codigo').addEventListener('click', copiarCodigo);

    // Polling (15s) só enquanto a página está VISÍVEL: aba escondida ou
    // celular no bolso não consulta nada. Isso é o que segura o custo quando
    // muita gente tem a página aberta ao mesmo tempo (Jorge, 10/08: cuidado
    // com performance no volume). Para de vez quando confirma ou expira.
    var poll = null;
    function consultar(){
      fetch('/pix/' + token + '/status', { cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (j.estado === 'pago')     { pararTudo(); pagar(); }
          if (j.estado === 'expirado') { pararTudo(); expirar(); }
        })
        .catch(function(){});
    }
    function pararTudo(){ if (poll) { clearInterval(poll); poll = null; } clearInterval(iv); }
    function ligarPolling(){ if (!poll && !document.hidden) poll = setInterval(consultar, 15000); }
    function desligarPolling(){ if (poll) { clearInterval(poll); poll = null; } }
    document.addEventListener('visibilitychange', function(){
      if (document.hidden) desligarPolling();
      else { consultar(); ligarPolling(); } // voltou pra tela: confere na hora
    });
    ligarPolling();
  }
})();
</script>
</body>
</html>`;
}

// Token inválido/desconhecido: página neutra, sem NENHUM dado (anti-enumeração)
export function renderPaginaNaoEncontrada(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Hidrabene</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#f7ddd6;color:#2b1d16;display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px;text-align:center}p{max-width:320px;line-height:1.6}</style>
</head><body><p><b>Essa página não está mais disponível.</b><br>Qualquer dúvida sobre seu pedido, é só responder nossa conversa no WhatsApp. 💛</p></body></html>`;
}
