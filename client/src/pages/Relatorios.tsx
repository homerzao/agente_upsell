import { useEffect, useState } from 'react';
import { ETAPA_LABEL, fmtBRL, get } from '../api';

const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export default function Relatorios() {
  const [de, setDe] = useState(diasAtras(30));
  const [ate, setAte] = useState(hoje());
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    get(`/api/relatorios?de=${de}&ate=${ate}`).then(setDados).catch((e) => setErro(e.message));
  }, [de, ate]);

  if (erro) return <div className="erro-msg">{erro}</div>;
  if (!dados) return <div>Carregando…</div>;

  const totalEtapas = dados.por_etapa.reduce((s: number, e: any) => s + e.n, 0) || 1;
  const disparados = dados.por_etapa
    .filter((e: any) => e.etapa !== 'fora_do_fluxo')
    .reduce((s: number, e: any) => s + e.n, 0);
  const pagos = Number(dados.vendas.pagos) || 0;
  const taxaPago = disparados ? Math.round((pagos / disparados) * 1000) / 10 : 0;

  return (
    <div>
      <h1>Relatórios</h1>
      <p className="sub">Conversão por etapa, custo de IA por venda e comparativo com o site.</p>
      <div className="linha" style={{ marginBottom: 16 }}>
        <div><label>De</label><input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></div>
        <div><label>Até</label><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></div>
      </div>

      <div className="cards">
        <div className="card"><div className="rotulo">Vendas do upsell</div><div className="valor verde">{pagos}</div></div>
        <div className="card"><div className="rotulo">Receita</div><div className="valor verde">{fmtBRL(dados.vendas.receita)}</div></div>
        <div className="card"><div className="rotulo">Conversão (pagos/entraram no funil)</div><div className="valor ouro">{taxaPago}%</div></div>
        <div className="card"><div className="rotulo">Referência site</div><div className="valor">{dados.comparativo_site.referencia_pct}%</div></div>
        <div className="card"><div className="rotulo">Respostas da IA</div><div className="valor">{dados.ia.respostas}</div></div>
        <div className="card"><div className="rotulo">Tokens</div><div className="valor">{Number(dados.ia.tokens).toLocaleString('pt-BR')}</div></div>
        <div className="card"><div className="rotulo">Custo IA total</div><div className="valor">{Number(dados.ia.custo).toFixed(4)}</div></div>
        <div className="card">
          <div className="rotulo">Custo IA por venda</div>
          <div className="valor">{dados.ia.custo_por_venda === null ? '—' : Number(dados.ia.custo_por_venda).toFixed(4)}</div>
        </div>
      </div>

      <div className="painel">
        <h2 style={{ marginTop: 0 }}>Funil por etapa</h2>
        <table>
          <thead><tr><th>Etapa</th><th>Status</th><th>Pedidos</th><th>%</th><th></th></tr></thead>
          <tbody>
            {dados.por_etapa.map((e: any) => (
              <tr key={`${e.etapa}-${e.status}`}>
                <td>{ETAPA_LABEL[e.etapa] ?? e.etapa}</td>
                <td><span className={`etiqueta ${e.status === 'open' ? 'open' : ''}`}>{e.status}</span></td>
                <td>{e.n}</td>
                <td>{Math.round((e.n / totalEtapas) * 1000) / 10}%</td>
                <td style={{ width: '40%' }}>
                  <div style={{ background: 'var(--panel2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      width: `${(e.n / totalEtapas) * 100}%`, height: 8, borderRadius: 4,
                      background: e.etapa === 'pago' ? 'var(--verde)' : e.etapa === 'fora_do_fluxo' ? '#4a5261' : 'var(--ouro)',
                    }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
