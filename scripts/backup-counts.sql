-- M1-7 恢复演练：列出 public 和 drizzle 两个 schema 里每张表的行数
-- 备份源和恢复出来的库各跑一次，再 diff 两个结果（用法见 README「备份和恢复」）
SELECT string_agg(
         format('SELECT %L AS table_name, count(*) AS row_count FROM %I.%I',
                schemaname || '.' || tablename, schemaname, tablename),
         E'\nUNION ALL\n' ORDER BY schemaname, tablename
       ) || E'\nORDER BY 1'
FROM pg_tables
WHERE schemaname IN ('public', 'drizzle')
\gexec
