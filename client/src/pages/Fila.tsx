import { useCallback, useEffect, useState } from 'react';
import { ETAPA_LABEL, fmtDataHora, get, post } from '../api';

export default function Fila() {
  const [filtros, setFiltros] = useState({ status: '', etapa: '', q: '', de: '', ate: '' });
  const [dados, setDados] = useState<{ total: number; rows: any[] }>({ total: 0, rows: [] });
  const [pagina, setPagina] = useState(0);
  const [msg, setMsg] = useState('');
  const limite = 50;

  const carregar = useCallback(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v) p.set(k, v);
    p.set('limit', String(limite));
    p.set('offset', String(pagina * limite));
    get(`/api/fila?${p}`).then(setDados).catch((e) => setMsg(e.message));
  }, [filtros, pagina]);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 15_000); // fila AO VIVO
    return () => clearInterval(t);
  }, [carregar]);

  const acao = async (r: any, tipo: 'fechar' | 'reenviar' | 'expirar') => {
    const confirmacoes = {
      fechar: `Fechar o pedido ${r.order_id} manualmente?`,
      reenviar: `Reenviar o template pro pedido ${r.order_id}? (reabre o funil)`,
      expirar: `Forçar expiração do PIX do pedido ${r.order_id}?`,
    };
    if (!window.confirm(confirmacoes[tipo])) return;
    try {
      await post(`/api/fila/${r.store}/${r.order_id}/${tipo}`, tipo === 'fechar' ? { motivo: null } : undefined);
      setMsg(`✅ ${tipo} ok (pedido ${r.order_id})`);
      carregar();
    } catch (e: any) {
      setMsg(`Erro: ${e.message}`);
    }
  };

  const set = (k: string, v: string) => {
    setPagina(0);
    setFiltros((f) => ({ ...f, [k]: v }));
  };

  return (
    <div>
      <h1>Fila ao vivo</h1>
      <p className="sub">{dados.total} registros · atualiza a cada 15s</p>
      <div className="linha" style={{ marginBottom: 14 }}>
        <div>
          <label>Busca (pedido, telefone, CPF, nome)</label>
          <input value={filtros.q} onChange={(e) => set('q', e.target.value)} style={{ width: 240 }} />
        </div>
        <div>
          <label>Status</label>
          <select value={filtros.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">todos</option>
            <option value="open">open</option>
            <option value="closed">closed</option>
          </select>
        </div>
        <div>
          <label>Etapa</label>
          <select value={filtros.etapa} onChange={(e) => set('etapa', e.target.value)}>
            <option value="">todas</option>
            {Object.entries(ETAPA_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label>De</label>
          <input type="date" value={filtros.de} onChange={(e) => set('de', e.target.value)} />
        </div>
        <div>
          <label>Até</label>
          <input type="date" value={filtros.ate} onChange={(e) => set('ate', e.target.value)} />
        </div>
      </div>
      {msg && <div className="aviso">{msg}</div>}
      <div className="painel" style={{ overflowX: 'auto', padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Pedido</th><th>Cliente</th><th>Status</th><th>Etapa</th><th>Disparo</th>
              <th>PIX</th><th>Criado</th><th>Atualizado</th><th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {dados.rows.map((r) => (
              <tr key={`${r.store}-${r.order_id}`}>
                <td>
                  <b>{r.order_id}</b>
                  <div className="mono" style={{ color: 'var(--texto2)' }}>#{r.order_number}</div>
                </td>
                <td>
                  {r.customer_name ?? '—'}
                  <div className="mono" style={{ color: 'var(--texto2)' }}>{r.customer_phone}</div>
                </td>
                <td><span className={`etiqueta ${r.status === 'open' ? 'open' : ''}`}>{r.status}</span></td>
                <td>
                  <span className={`etiqueta ${r.etapa === 'pago' ? 'pago' : r.etapa === 'erro_disparo' ? 'erro' : ''}`}>
                    {ETAPA_LABEL[r.etapa] ?? r.etapa}
                  </span>
                </td>
                <td>{r.disparo_status ?? '—'}</td>
                <td>{r.pix_charge_id ? <span className="mono">{r.pix_charge_id.slice(0, 12)}…</span> : '—'}</td>
                <td>{fmtDataHora(r.criado_em)}</td>
                <td>{fmtDataHora(r.atualizado_em)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.status === 'open' && (
                    <button onClick={() => acao(r, 'fechar')} style={{ marginRight: 6 }}>Fechar</button>
                  )}
                  {r.etapa === 'pix_enviado' && (
                    <button onClick={() => acao(r, 'expirar')} style={{ marginRight: 6 }}>Expirar</button>
                  )}
                  {r.store !== 'sandbox' && <button onClick={() => acao(r, 'reenviar')}>Reenviar</button>}
                </td>
              </tr>
            ))}
            {!dados.rows.length && (
              <tr><td colSpan={9} className="sub" style={{ padding: 20 }}>Nada na fila com esses filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="linha" style={{ marginTop: 12 }}>
        <button disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>← Anterior</button>
        <span className="sub" style={{ margin: '0 8px' }}>página {pagina + 1}</span>
        <button disabled={(pagina + 1) * limite >= dados.total} onClick={() => setPagina((p) => p + 1)}>Próxima →</button>
      </div>
    </div>
  );
}
