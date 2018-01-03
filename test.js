process.on('unhandledRejection', (err) => console.log(err.stack));

var RuleEngine = require('./lib/node-rules.js');

var engine = new RuleEngine([{
    conditions: [{ items: { '#min': { $lt: 4 }}}, { 'items#max': { $maxOf: { $field: 'items' }}}],
    consequences: [{ items: { $each: { $mul: { $field: 'item' }}}}],
}]);

engine.execute({ items: [1, 3, 5, 2], item: 4 }).then(console.log);
