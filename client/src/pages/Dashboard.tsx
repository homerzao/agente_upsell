import { useEffect, useState } from 'react';
import { fmtBRL, get } from '../api';

const hoje = () => new Date().toISOString().slice(0, 10);
// segundos -> "12s" / "3min" / "1h20" (medianas do funil)
const fmtDuracao = (seg: number | null) => {
  if (seg === null || seg === undefined) return '—';
  if (seg < 60) return `${seg}s`;
  if (seg < 3600) return `${Math.round(seg / 60)}min`;
  const h = Math.floor(seg / 3600);
  const m = Math.round((seg % 3600) / 60);
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};
const diasAtras = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export default function Dashboard() {
  const [de, setDe] = useState(diasAtras(14));
  const [ate, setAte] = useState(hoje());
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    get(`/api/dashboard?de=${de}&ate=${ate}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [de, ate]);

  const c = dados?.cards;
  const maxDia = Math.max(1, ...(dados?.diario ?? []).map((d: any) => d.disparos));

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="sub">Funil do upsell pós-compra (fuso America/São_Paulo)</p>
      <div className="linha" style={{ marginBottom: 16 }}>
        <div>
          <label>De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} />
        </div>
        <div>
          <label>Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
        </div>
        <button onClick={() => { setDe(diasAtras(14)); setAte(hoje()); }}>Últimos 14 dias</button>
        <button onClick={() => { setDe(diasAtras(30)); setAte(hoje()); }}>30 dias</button>
      </div>
      {erro && <div className="erro-msg">{erro}</div>}
      {c && (
        <>
          <div className="cards">
            <div className="card"><div className="rotulo">Disparos</div><div className="valor">{c.disparos}</div></div>
            <div className="card"><div className="rotulo">Entregues</div><div className="valor">{c.entregues}</div></div>
            <div className="card"><div className="rotulo">Aceites (PIX gerado)</div><div className="valor">{c.aceites}</div></div>
            <div className="card"><div className="rotulo">Aceite %</div><div className="valor ouro">{c.taxa_aceite}%</div></div>
            <div className="card"><div className="rotulo">Pagos</div><div className="valor verde">{c.pagos}</div></div>
            <div className="card"><div className="rotulo">Pago %</div><div className="valor verde">{c.taxa_pago}%</div></div>
            <div className="card"><div className="rotulo">Receita</div><div className="valor verde">{fmtBRL(c.receita)}</div></div>
            <div className="card"><div className="rotulo">Correções</div><div className="valor">{c.correcoes}</div></div>
            <div className="card"><div className="rotulo">Sem resposta</div><div className="valor">{c.sem_resposta}</div></div>
            <div className="card"><div className="rotulo">Recusados</div><div className="valor">{c.recusados}</div></div>
          </div>
          <div className="aviso">
            Referência: o upsell do site converte ~{c.referencia_site}% — o funil de WhatsApp está em{' '}
            <b>{c.taxa_pago}%</b> de pagamento sobre disparos no período.
          </div>
          {dados.funil && (
            <div className="painel">
              <h2 style={{ marginTop: 0 }}>Funil etapa a etapa</h2>
              <p className="sub" style={{ marginTop: 0 }}>
                Cada % é sobre a etapa ANTERIOR — é assim que o gargalo aparece sozinho.
              </p>
              {[
                { rotulo: 'Enviados', n: dados.funil.enviados, pct: null, cor: '#4a5261' },
                { rotulo: 'Entregues', n: dados.funil.entregues, pct: dados.funil.taxa_entrega, cor: '#4a5261' },
                { rotulo: 'Leram', n: dados.funil.lidos, pct: dados.funil.taxa_leitura, cor: '#5b6b8c' },
                { rotulo: 'Abriram o flow', n: dados.funil.abriram_flow, pct: dados.funil.taxa_abertura, cor: '#7a6ea8' },
                { rotulo: 'Aceitaram (PIX)', n: dados.funil.aceites, pct: dados.funil.taxa_aceite, cor: 'var(--ouro)' },
                { rotulo: 'Pagaram', n: dados.funil.pagos, pct: dados.funil.taxa_pagamento, cor: 'var(--verde)' },
              ].map((e) => (
                <div key={e.rotulo} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
                  <div style={{ width: 130, fontSize: 13, color: 'var(--texto2)' }}>{e.rotulo}</div>
                  <div style={{ flex: 1, background: '#1e2229', borderRadius: 6, height: 26, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${dados.funil.enviados ? Math.max(3, (e.n / dados.funil.enviados) * 100) : 0}%`,
                        background: e.cor,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#0d0f13',
                        borderRadius: 6,
                      }}
                    >
                      {e.n}
                    </div>
                  </div>
                  <div style={{ width: 64, textAlign: 'right', fontSize: 13 }}>
                    {e.pct === null ? '—' : `${e.pct}%`}
                  </div>
                </div>
              ))}
              <div className="linha" style={{ gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
                <span className="sub" style={{ margin: 0 }}>
                  Recusaram: <b>{dados.funil.recusas}</b> ({dados.funil.taxa_recusa}% de quem abriu)
                </span>
                <span className="sub" style={{ margin: 0 }}>Correções: <b>{dados.funil.correcoes}</b></span>
                <span className="sub" style={{ margin: 0 }}>
                  Aceitou e não pagou: <b>{dados.funil.expirados}</b>
                </span>
                <span className="sub" style={{ margin: 0 }}>
                  Pago sobre enviados: <b>{dados.funil.taxa_pago_no_total}%</b>
                </span>
              </div>
              <div className="linha" style={{ gap: 20, flexWrap: 'wrap', marginTop: 4 }}>
                <span className="sub" style={{ margin: 0 }}>⏱️ até ler: <b>{fmtDuracao(dados.funil.tempos.ate_ler_seg)}</b></span>
                <span className="sub" style={{ margin: 0 }}>ler → abrir: <b>{fmtDuracao(dados.funil.tempos.ler_ate_abrir_seg)}</b></span>
                <span className="sub" style={{ margin: 0 }}>abrir → aceitar: <b>{fmtDuracao(dados.funil.tempos.abrir_ate_aceitar_seg)}</b></span>
                <span className="sub" style={{ margin: 0 }}>(medianas)</span>
              </div>
            </div>
          )}

          <div className="painel">
            <h2 style={{ marginTop: 0 }}>Por dia — disparos (cinza), aceites (dourado), pagos (verde)</h2>
            <div className="grafico">
              {(dados.diario ?? []).map((d: any) => (
                <div key={d.dia} className="barra-grupo" title={`${d.dia}: ${d.disparos} disparos, ${d.aceites} aceites, ${d.pagos} pagos`}>
                  <div className="barras">
                    <div className="barra" style={{ height: `${(d.disparos / maxDia) * 100}%`, background: '#4a5261' }} />
                    <div className="barra" style={{ height: `${(d.aceites / maxDia) * 100}%`, background: 'var(--ouro)' }} />
                    <div className="barra" style={{ height: `${(d.pagos / maxDia) * 100}%`, background: 'var(--verde)' }} />
                  </div>
                  <div className="dia">{String(d.dia).slice(5)}</div>
                </div>
              ))}
              {!dados.diario?.length && <div className="sub">Sem dados no período.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
