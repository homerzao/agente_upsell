import { useEffect, useState } from 'react';
import { fmtDataHora, get } from '../api';

export default function Conversas() {
  const [dados, setDados] = useState<{ conversas: any[]; chatwoot_link_base: string | null }>({
    conversas: [],
    chatwoot_link_base: null,
  });
  const [sel, setSel] = useState<any>(null);
  const [mensagens, setMensagens] = useState<any[]>([]);
  const [erro, setErro] = useState('');

  useEffect(() => {
    get('/api/conversas').then(setDados).catch((e) => setErro(e.message));
  }, []);

  const abrir = (c: any) => {
    setSel(c);
    get(`/api/conversas/${c.id}/mensagens`).then((r) => setMensagens(r.mensagens)).catch((e) => setErro(e.message));
  };

  return (
    <div>
      <h1>Conversas do agente</h1>
      <p className="sub">Espelho somente-leitura — a operação da conversa acontece no Chatwoot.</p>
      {erro && <div className="erro-msg">{erro}</div>}
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
              {!dados.conversas.length && <tr><td colSpan={3} className="sub" style={{ padding: 16 }}>Nenhuma conversa ainda.</td></tr>}
            </tbody>
          </table>
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
                {dados.chatwoot_link_base && sel.chatwoot_conversation_id && (
                  <a href={`${dados.chatwoot_link_base}/${sel.chatwoot_conversation_id}`} target="_blank" rel="noreferrer">
                    Abrir no Chatwoot ↗
                  </a>
                )}
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
