import { FormEvent, useState } from 'react';
import { post } from '../api';

export default function Login({ onLogin }: { onLogin: (user: string, csrf: string) => void }) {
  const [user, setUser] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      const r = await post('/api/auth/login', { user, senha });
      onLogin(r.user, r.csrf);
    } catch (err: any) {
      setErro(err.message ?? 'falha no login');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={enviar}>
        <h1>🏆 Upsell Hidrabene</h1>
        <p className="sub">Painel de gestão do funil de WhatsApp</p>
        <div className="campo">
          <label>Usuário</label>
          <input value={user} onChange={(e) => setUser(e.target.value)} autoFocus style={{ width: '100%' }} />
        </div>
        <div className="campo">
          <label>Senha</label>
          <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} style={{ width: '100%' }} />
        </div>
        <button className="primario" disabled={enviando || !user || !senha} style={{ width: '100%' }}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
        {erro && <div className="erro-msg">{erro}</div>}
      </form>
    </div>
  );
}
