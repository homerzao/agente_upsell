import { useEffect, useState } from 'react';
import { fmtBRL, get } from '../api';

const hoje = () => new Date().toISOString().slice(0, 10);
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
