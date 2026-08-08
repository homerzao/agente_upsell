import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

function dirMigrations(): string {
  // Produção (Dockerfile copia pra /app/migrations); dev roda de src/db/migrations.
  const candidatos = [join(process.cwd(), 'migrations'), join(__dirname, 'migrations')];
  for (const c of candidatos) if (existsSync(c)) return c;
  throw new Error('diretório de migrations não encontrado');
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT now()
  )`);
  const dir = dirMigrations();
  const arquivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas: string[] = [];
  for (const f of arquivos) {
    const ja = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
    if (ja.rows.length) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      aplicadas.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} falhou: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return aplicadas;
}
