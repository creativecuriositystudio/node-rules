process.on('unhandledRejection', (err) => console.log(err.stack));

var RuleEngine = require('./lib/node-rules.js');

var engine = new RuleEngine([{
    condition: [{ items: { '#min': { $lt: 4 }}}, { 'items#max': { $maxOf: { $field: 'items' } }}],
    consequence: function (engine) { this.items = false; this.matched = true; engine.stop(); },
}]);

engine.execute({ items: [1, 3, 5, 2], item: 4 }).then(console.log);
