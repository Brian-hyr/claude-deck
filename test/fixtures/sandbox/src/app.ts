// Arquivo de exemplo para testar o editor (realce, busca, salvar).
export interface Servidor {
  alias: string;
  porta: number;
  favorito: boolean;
}

export function descrever(s: Servidor): string {
  const marca = s.favorito ? '★' : ' ';
  return `${marca} ${s.alias}:${s.porta}`;
}

const lista: Servidor[] = [
  { alias: 'srv-linux-1', porta: 22, favorito: true },
  { alias: 'srv-linux-2', porta: 2222, favorito: true },
];

for (const s of lista) console.log(descrever(s));
