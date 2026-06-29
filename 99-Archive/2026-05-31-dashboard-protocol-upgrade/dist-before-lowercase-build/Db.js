import pg from "pg";
import { config } from "./config.js";
const { Pool } = pg;
export const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
});
export async function checkDb() {
    const result = await pool.query("select 1 as ok");
    return result.rows[0]?.ok === 1;
}
export async function getPersonBySlug(slug) {
    const result = await pool.query("select id, slug, display_label, relation_label, status, created_at from health_memory.persons where slug = $1 and status = 'active'", [slug]);
    return result.rows[0] ?? null;
}
export async function withPerson(slug, fn) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("set local search_path to health_memory, public");
        const personResult = await client.query("select id, slug, display_label, relation_label, status, created_at from persons where slug = $1 and status = 'active'", [slug]);
        const person = personResult.rows[0];
        if (!person) {
            const error = new Error(`person_not_found:${slug}`);
            error.statusCode = 404;
            throw error;
        }
        await client.query("select set_config('app.person_id', $1, true)", [person.id]);
        const value = await fn(client, person);
        await client.query("commit");
        return value;
    }
    catch (error) {
        await client.query("rollback");
        throw error;
    }
    finally {
        client.release();
    }
}
