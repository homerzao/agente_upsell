import { useEffect, useState } from 'react';
import { fmtDataHora, get } from '../api';

const POR_PAGINA = 50;

export default function Conversas() {
  const [dados, setDados] = useState<{ conversas: any[]; total: number; chatwoot_link_base: string | null }>({
    conversas: [],
    total: 0,
    chatwoot_link_base: null,
  });
  const [sel, setSel] = useState<any>(null);
  const [mensagens, setMensagens] = useState<any[]>([]);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [status, setStatus] = useState('');
  const [pagina, setPagina] = useState(0);

  const carregar = () => {
    const params = new URLSearchParams();
    params.set('limit', String(POR_PAGINA));
    params.set('offset', String(pagina * POR_PAGINA));
    if (buscaAtiva) params.set('q', buscaAtiva);
    if (status) params.set('status', status);
    get(`/api/conversas?${params}`).then(setDados).catch((e) => setErro(e.message));
  };

  useEffect(carregar, [pagina, buscaAtiva, status]);
  // auto-refresh: acompanhar interação chegando sem precisar recarregar a página
  useEffect(() => {
    const t = setInterval(carregar, 15000);
    return () => clearInterval(t);
  }, [pagina, buscaAtiva, status]);

  const abrir = (c: any) => {
    setSel(c);
    get(`/api/conversas/${c.id}/mensagens`).then((r) => setMensagens(r.mensagens)).catch((e) => setErro(e.message));
  };

  const totalPaginas = Math.max(1, Math.ceil(dados.total / POR_PAGINA));

  return (
    <div>
      <h1>Conversas do agente</h1>
      <p className="sub">Espelho somente-leitura — a operação da conversa acontece no Chatwoot.</p>
      {erro && <div className="erro-msg">{erro}</div>}
      <div className="linha" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          placeholder="Buscar nome, fone ou pedido…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPagina(0);
              setBuscaAtiva(busca.trim());
            }
          }}
          style={{ minWidth: 240 }}
        />
        <button onClick={() => { setPagina(0); setBuscaAtiva(busca.trim()); }}>Buscar</button>
        <select value={status} onChange={(e) => { setPagina(0); setStatus(e.target.value); }}>
          <option value="">Todas</option>
          <option value="bot">🤖 bot</option>
          <option value="humano">👤 humano</option>
        </select>
        {buscaAtiva && (
          <button onClick={() => { setBusca(''); setBuscaAtiva(''); setPagina(0); }}>Limpar</button>
        )}
        <span className="sub" style={{ margin: 0 }}>
          {dados.total} conversa{dados.total === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16 }}>
        <div className="painel" style={{ padding: 0, maxHeight: 600, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr><th>Pedido / cliente</th><th>Status</th><th>Msgs</th></tr>
            </thead>
            <tbody>
              {dados.conversas.map((c) => (
                <tr key={c.id} onClick={() => abrir(c)} style={{ cursor: 'pointer' }}>
                  <td>
                    <b>{c.order_id ?? '—'}</b> {c.customer_name ?? ''}
                    <div className="sub" style={{ margin: 0 }}>{fmtDataHora(c.atualizado_em)}</div>
                  </td>
                  <td>
                    <span className={`etiqueta ${c.status === 'humano' ? 'erro' : 'pago'}`}>
                      {c.status === 'humano' ? '👤 humano' : '🤖 bot'}
                    </span>
                    {c.handoff_motivo && <div className="sub" style={{ margin: 0 }}>{c.handoff_motivo}</div>}
                  </td>
                  <td>{c.mensagens}</td>
                </tr>
              ))}
              {!dados.conversas.length && <tr><td colSpan={3} className="sub" style={{ padding: 16 }}>Nenhuma conversa encontrada.</td></tr>}
            </tbody>
          </table>
          {totalPaginas > 1 && (
            <div className="linha" style={{ gap: 8, padding: 10, justifyContent: 'center' }}>
              <button disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>← Anterior</button>
              <span className="sub" style={{ margin: 0 }}>{pagina + 1} / {totalPaginas}</span>
              <button disabled={pagina >= totalPaginas - 1} onClick={() => setPagina(pagina + 1)}>Próxima →</button>
            </div>
          )}
        </div>
        <div className="painel">
          {!sel && <div className="sub">Selecione uma conversa.</div>}
          {sel && (
            <>
              <div className="linha" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <b>Pedido {sel.order_id}</b> — {sel.customer_name} · etapa {sel.etapa}
                  {sel.custo > 0 && <span className="sub"> · custo IA {Number(sel.custo).toFixed(4)}</span>}
                </div>
                <div className="linha" style={{ gap: 12 }}>
                  <a onClick={() => abrir(sel)} style={{ cursor: 'pointer' }}>↻ Atualizar</a>
                  {dados.chatwoot_link_base && sel.chatwoot_conversation_id && (
                    <a href={`${dados.chatwoot_link_base}/${sel.chatwoot_conversation_id}`} target="_blank" rel="noreferrer">
                      Abrir no Chatwoot ↗
                    </a>
                  )}
                </div>
              </div>
              <div className="chat">
                {mensagens.map((m) => (
                  <div key={m.id} className={`msg ${m.direcao}`}>
                    {m.texto}
                    <div className="meta">
                      {fmtDataHora(m.criado_em)}
                      {m.tokens ? ` · ${m.tokens} tokens` : ''}
                      {m.prompt_hash ? ` · prompt ${String(m.prompt_hash).slice(0, 8)}` : ''}
                    </div>
                  </div>
                ))}
                {!mensagens.length && <div className="sub">Sem mensagens registradas.</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
