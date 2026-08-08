import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { get, post, setCsrf } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Fila from './pages/Fila';
import Disparo from './pages/Disparo';
import Oferta from './pages/Oferta';
import Aprovacoes from './pages/Aprovacoes';
import Conversas from './pages/Conversas';
import Relatorios from './pages/Relatorios';
import Config from './pages/Config';

type Auth = { carregando: boolean; user: string | null };

function Layout({ user, onLogout, children }: { user: string; onLogout: () => void; children: React.ReactNode }) {
  const [pendentes, setPendentes] = useState(0);
  useEffect(() => {
    const carregar = () =>
      get('/api/aprovacoes')
        .then((r) => setPendentes(r.correcoes.filter((c: any) => c.status === 'aguardando_aprovacao').length))
        .catch(() => {});
    carregar();
    const t = setInterval(carregar, 30_000);
    return () => clearInterval(t);
  }, []);
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'ativo' : '');
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">🏆 Upsell Hidrabene</div>
        <nav>
          <NavLink to="/" end className={cls}>Dashboard</NavLink>
          <NavLink to="/fila" className={cls}>Fila ao vivo</NavLink>
          <NavLink to="/disparo" className={cls}>Disparo controlado</NavLink>
          <NavLink to="/oferta" className={cls}>Oferta</NavLink>
          <NavLink to="/aprovacoes" className={cls}>
            Aprovações{pendentes > 0 ? ` (${pendentes})` : ''}
          </NavLink>
          <NavLink to="/conversas" className={cls}>Conversas</NavLink>
          <NavLink to="/relatorios" className={cls}>Relatórios</NavLink>
          <NavLink to="/config" className={cls}>Config</NavLink>
        </nav>
        <div className="rodape">
          <div style={{ color: 'var(--texto2)', fontSize: 12, marginBottom: 8 }}>{user}</div>
          <button onClick={onLogout}>Sair</button>
        </div>
      </aside>
      <main className="conteudo">{children}</main>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<Auth>({ carregando: true, user: null });
  const navigate = useNavigate();

  useEffect(() => {
    get('/api/auth/me')
      .then((r) => {
        setCsrf(r.csrf);
        setAuth({ carregando: false, user: r.user });
      })
      .catch(() => setAuth({ carregando: false, user: null }));
  }, []);

  const onLogin = (user: string, csrf: string) => {
    setCsrf(csrf);
    setAuth({ carregando: false, user });
    navigate('/');
  };

  const onLogout = async () => {
    await post('/api/auth/logout').catch(() => {});
    setCsrf(null);
    setAuth({ carregando: false, user: null });
    navigate('/login');
  };

  if (auth.carregando) return <div className="login-wrap">Carregando…</div>;

  if (!auth.user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={onLogin} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout user={auth.user} onLogout={onLogout}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/fila" element={<Fila />} />
        <Route path="/disparo" element={<Disparo />} />
        <Route path="/oferta" element={<Oferta />} />
        <Route path="/aprovacoes" element={<Aprovacoes />} />
        <Route path="/conversas" element={<Conversas />} />
        <Route path="/relatorios" element={<Relatorios />} />
        <Route path="/config" element={<Config />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
