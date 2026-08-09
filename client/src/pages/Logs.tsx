import { useEffect, useState } from 'react';
import { fmtDataHora, get, put } from '../api';

// Aba de diagnóstico (pedido do Jorge, 09/08): ver o que chega da Meta em tempo
// real, com toggle do debug — investigar entrega/distribuição sem SSH.
export default function Logs() {
  const [dados, setDados] = useState<{ logs: any[]; debug_meta: boolean }>({ logs: [], debug_meta: false });
  const [tipo, setTipo] = useState('debug');
  const [pausadoRefresh, setPausadoRefresh] = useState(false);
  const [msg, setMsg] = useState('');

  const carregar = () => {
    get(`/api/logs?tipo=${tipo}&limit=150`).then(setDados).catch((e) => setMsg(e.message));
  };

  useEffect(carregar, [tipo]);
  useEffect(() => {
    if (pausadoRefresh) return;
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, [tipo, pausadoRefresh]);

  const toggleDebug = async () => {
    try {
      await put('/api/disparo', { debug_meta: !dados.debug_meta });
      setMsg(dados.debug_meta ? 'Debug DESLIGADO' : 'Debug LIGADO — todo webhook da Meta gera uma linha');
      carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  const resumo = (p: any) => {
    if (p.debug === 'meta_in') return `📡 META: ${JSON.stringify(p.resumo)}`;
    if (p.erro) return `❌ ${p.erro}${p.detalhe ? ` — ${p.detalhe}` : ''}${p.order_id ? ` (pedido ${p.order_id})` : ''}`;
    if (p.tipo) return `✉️ ${p.tipo}${p.order_id ? ` (pedido ${p.order_id})` : ''}`;
    if (p.evento) return `⚙️ ${p.evento}${p.order_id ? ` (pedido ${p.order_id})` : ''}`;
    return JSON.stringify(p).slice(0, 160);
  };

  return (
    <div>
      <h1>Logs do sistema</h1>
      <p className="sub">
        Diagnóstico ao vivo (atualiza a cada 5s). O debug da Meta loga UMA linha por webhook
        recebido (campo, tipos e remetente — nunca o conteúdo). Com o firehose do SAC, não
        deixar ligado pra sempre.
      </p>
      {msg && <div className="aviso">{msg}</div>}
      <div className="linha" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={toggleDebug} className={dados.debug_meta ? 'perigo' : ''}>
          {dados.debug_meta ? '🔴 Desligar debug da Meta' : '🟢 Ligar debug da Meta'}
        </button>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="debug">📡 Debug Meta (o que chega)</option>
          <option value="erro">❌ Erros</option>
          <option value="funil">✉️ Eventos do funil</option>
          <option value="tudo">Tudo</option>
        </select>
        <button onClick={() => setPausadoRefresh(!pausadoRefresh)}>
          {pausadoRefresh ? '▶ Retomar atualização' : '⏸ Pausar atualização'}
        </button>
        <span className="sub" style={{ margin: 0 }}>{dados.logs.length} linhas</span>
      </div>
      <div className="painel" style={{ padding: 0, maxHeight: 640, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr><th style={{ width: 150 }}>Quando</th><th style={{ width: 80 }}>Origem</th><th>Evento</th></tr>
          </thead>
          <tbody>
            {dados.logs.map((l) => (
              <tr key={l.id}>
                <td className="mono">{fmtDataHora(l.created_at)}</td>
                <td>{l.store}</td>
                <td className="mono" style={{ fontSize: 12 }}>{resumo(l.payload ?? {})}</td>
              </tr>
            ))}
            {!dados.logs.length && <tr><td colSpan={3} className="sub" style={{ padding: 16 }}>Nada registrado com esse filtro.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
