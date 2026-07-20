/** Renders a SQL single-quoted string literal with embedded quotes doubled. */
export const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
