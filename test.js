process.on('unhandledRejection', (err) => console.log(err.stack));

var RuleEngine = require('./lib/node-rules.js');
var moment = require('moment');

var engine = new RuleEngine([{
    name: 'test-rule',
    priority: 0,
    conditions: [{
        items: { '#min': { $lt: 4 }},
        'items#max': { $maxOf: { $field: 'items' }},
        index: 2,
    }],
    consequences: [{
        items: { $each: { $mul: { $field: 'multiplier' }}},
        daysBetween: { $daysBetween: [{ $field: 'dateB' }, { $field: 'dateA' }]},
        '_global.this': 'isGlobal',
    }],
}]);

var now = moment();

engine.execute({
    items: [1, 3, 5, 2],
    multiplier: 4,
    dateA: now.toDate(),
    dateB: now.add(5, 'days').toISOString(),
    daysBetween: null,
    index: [1, 2]
}, ['index', { this: 'isNotGlobal' }]).then(console.log);
