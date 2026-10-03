document.getElementById('js').textContent = 'JavaScript rodou dentro do visualizador (isolado).';
// Prova de isolamento: a página não enxerga os cookies do app.
let c = '';
try {
  c = document.cookie;
} catch (e) {
  c = 'bloqueado: ' + e.name;
}
document.getElementById('cookie').textContent = 'Cookies visíveis para a página: ' + (c || '(nenhum)');
