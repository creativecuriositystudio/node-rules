var RuleEngine = require('./lib/node-rules.js');

var engine = new RuleEngine([{
    condition: [{ length: { $gt: 7 } }, { length: { $lte: 5 }}],
    consequence: function (engine) { this.length = 1; this.matched = true; engine.stop(); },
}]);

engine.execute({ length: 5 }, function (result) {
    console.log(result);
});
