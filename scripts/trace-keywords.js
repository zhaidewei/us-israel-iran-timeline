const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

const GEO = ['israel','iran','gaza','tehran','idf','irgc','khamenei','netanyahu','hezbollah','hamas','rafah','west bank','beirut','pentagon'];
const ACTION = ['missile','strike','attack','bomb','drone','airstrike','nuclear','war','ceasefire','hostage','sanction','retaliation','intercept','killed','kills'];

const TARGET = ['australia-aged-care-home-support', 'violent-and-menacing-threats-to-australias-politicians'];

parser.parseURL('https://www.theguardian.com/world/rss').then(feed => {
  for (const item of feed.items) {
    const link = item.link || '';
    if (TARGET.every(t => !link.includes(t))) continue;

    const text = (item.title + ' ' + (item.contentSnippet || '') + ' ' + (item.content || '')).toLowerCase();
    const geoHits = GEO.filter(k => text.includes(k));
    const actionHits = ACTION.filter(k => text.includes(k));

    console.log('Title:', item.title);
    console.log('GEO hits:', geoHits);
    console.log('ACTION hits:', actionHits);
    geoHits.forEach(k => {
      const idx = text.indexOf(k);
      console.log('  GEO "' + k + '":', text.slice(Math.max(0, idx - 60), idx + 80).replace(/\s+/g, ' '));
    });
    actionHits.forEach(k => {
      const idx = text.indexOf(k);
      console.log('  ACTION "' + k + '":', text.slice(Math.max(0, idx - 60), idx + 80).replace(/\s+/g, ' '));
    });
    console.log('---');
  }
}).catch(err => console.error(err.message));
