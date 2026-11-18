const fs = require('fs');

const inCI = () => process.env.GITHUB_ACTIONS === 'true';

function ts() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
}

// Escapes dos "workflow commands" do GitHub Actions
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

// No GitHub vira anotação visível no resumo da execução; local vira log normal
function annotate(level, title, message) {
  if (inCI()) console.log(`::${level} title=${escProp(title)}::${escData(message)}`);
  else log(`${level === 'error' ? '✖' : level === 'warning' ? '⚠' : 'ℹ'} ${title}: ${message}`);
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${markdown}\n`);
}

module.exports = { log, annotate, summary };
