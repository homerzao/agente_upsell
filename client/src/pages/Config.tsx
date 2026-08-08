import { useEffect, useState } from 'react';
import { get, post } from '../api';

export default function Config() {
  const [cfg, setCfg] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [testando, setTestando] = useState(false);

  useEffect(() => {
    get('/api/config').then(setCfg).catch((e) => setMsg(e.message));
  }, []);

  const copiar = (v: string) => {
    navigator.clipboard.writeText(v).then(() => setMsg('✅ Copiado'));
  };

  const testSend = async () => {
    setTestando(true);
    setMsg('');
    try {
      const r = await post('/api/config/test-send');
      setMsg(r.ok ? `✅ Mensagem de teste enviada pro ${cfg.fone_teste}` : `Falhou: ${r.erro}`);
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setTestando(false);
    }
  };

  const criarWebhookYampi = async () => {
    if (!window.confirm('Criar e ATIVAR o webhook na Yampi apontando pra este sistema?')) return;
    try {
      await post('/api/config/webhooks/yampi');
      setMsg('✅ Webhook criado e ativado na Yampi');
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  if (!cfg) return <div>Carregando…</div>;

  const chip = (ok: boolean) => (
    <span className={`etiqueta ${ok ? 'pago' : 'erro'}`}>{ok ? 'configurado' : 'FALTANDO'}</span>
  );

  return (
    <div>
      <h1>Config</h1>
      <p className="sub">
        Modo atual: <b>{cfg.modo}</b> · fone de teste {cfg.fone_teste} · modelo {cfg.modelo_ia} · template{' '}
        {cfg.template} · flow {cfg.flow_id}
      </p>
      {msg && <div className="aviso">{msg}</div>}

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Integrações</h2>
        <table>
          <tbody>
            <tr><td>Yampi</td><td>{chip(cfg.integracoes.yampi)}</td><td className="mono">{cfg.credenciais_mascaradas.YAMPI_TOKEN}</td></tr>
            <tr><td>Pagar.me</td><td>{chip(cfg.integracoes.pagarme)}</td><td className="mono">{cfg.credenciais_mascaradas.PAGARME_SECRET_KEY}</td></tr>
            <tr><td>Meta WhatsApp</td><td>{chip(cfg.integracoes.meta)}</td><td className="mono">{cfg.credenciais_mascaradas.METAWA_TOKEN}</td></tr>
            <tr><td>Chatwoot</td><td>{chip(cfg.integracoes.chatwoot)}</td><td className="mono">{cfg.credenciais_mascaradas.CHATWOOT_API_TOKEN}</td></tr>
            <tr><td>OpenAI</td><td>{chip(cfg.integracoes.openai)}</td><td className="mono">{cfg.credenciais_mascaradas.OPENAI_API_KEY}</td></tr>
            <tr><td>Status API (faturamento)</td><td>{chip(cfg.integracoes.status_api)}</td><td className="mono">{cfg.credenciais_mascaradas.STATUS_TOKEN}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Webhooks de entrada</h2>
        <p className="sub">Clique pra copiar. Cadastrar na Yampi (botão abaixo), Pagar.me, Chatwoot e Meta.</p>
        <table>
          <tbody>
            {Object.entries(cfg.webhooks).map(([nome, url]) => (
              <tr key={nome}>
                <td style={{ width: 110 }}><b>{nome}</b></td>
                <td className="mono copiar" onClick={() => copiar(String(url))} title="clicar pra copiar">
                  {String(url)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="linha" style={{ marginTop: 12 }}>
          <button onClick={criarWebhookYampi}>Criar webhook na Yampi (já ativa)</button>
          <button disabled={testando} onClick={testSend}>
            {testando ? 'Enviando…' : '🔧 test-send WhatsApp'}
          </button>
        </div>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Notas de operação</h2>
        <ul className="sub" style={{ marginBottom: 0 }}>
          <li>Webhook da Meta: verificar com o METAWA_VERIFY_TOKEN no painel da Meta (ou manter o n8n forwardando nfm_reply — o endpoint aceita os dois formatos).</li>
          <li>Header do template usa media id que EXPIRA (~30 dias): preferir URL própria na copy header_url da oferta.</li>
          <li>Modo test manda TODA mensagem pro fone de teste; live só com decisão explícita na página Disparo.</li>
        </ul>
      </div>
    </div>
  );
}
