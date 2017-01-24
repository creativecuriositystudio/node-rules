(function() {
    'use strict';
    var _ = require('underscore');
    exports.version = '3.0.0';

    function RuleEngine(rules, options) {
        this.init();
        if (typeof(rules) != "undefined") {
            this.register(rules);
        }
        if (options) {
            this.ignoreFactChanges = options.ignoreFactChanges;
        }
        return this;
    }

    RuleEngine.prototype.init = function(rules) {
        this.rules = [];
        this.activeRules = [];
    };

    RuleEngine.prototype.register = function(rules) {
        if (Array.isArray(rules)) {
            this.rules = this.rules.concat(rules);
        } else if (rules !== null && typeof(rules) == "object") {
            this.rules.push(rules);
        }
        this.sync();
    };

    RuleEngine.prototype.sync = function() {
        this.activeRules = this.rules.filter(function(a) {
            if (typeof(a.on) === "undefined") {
                a.on = true;
            }
            if (a.on === true) {
                return a;
            }
        });
        this.activeRules.sort(function(a, b) {
            if (a.priority && b.priority) {
                return b.priority - a.priority;
            } else {
                return 0;
            }
        });
    };

    var dig = function (obj, properties) {
        return _.reduce(properties.split('.'), function (memo, prop) {
            // TODO implement array indexes
            return _.isObject(memo) ? memo[prop] : null;
        }, obj);
    };

    var testCondition = function (facts, condition) {
        var fact = dig(facts, condition.fact);

        var value = null;
        switch (condition.valueType) {
            case 'number': value = parseInt(condition.value, 10); break;
            case 'string': value = condition.value.toString(); break;
            case 'fact': value = dig(facts, condition.value); break;
        }

        condition.valueType dig(facts, condition.fact);
        switch (_conditions.operator) {
            case '<': return fact < value;
            case '<=': return fact <= value;
            case '=': return fact === value;
            case '>=': return fact >= value;
            case '>': return fact > value;
            case 'match': return fact.match(value);
            case 'includes': return fact.includes(value);
            default:
                // TODO implement custom operators with a global operator register
                return false;
        } 
    };

    var checkConditions = function (facts, conditions, isAll) {
        if (_conditions.fact) return testCondition(facts, conditions);

        if (!_.isArray(conditions)) return checkConditions(facts, _conditions.all || _conditions.any || _conditions, !_conditions.any);

        for (var condition in conditions) {
            var result = checkConditions(facts, _conditions.all || _conditions.any || _conditions, !_conditions.any);
            if (!result && isAll) return false;
            else if (result && !isAll) return true;
        }
        return isAll;
    }

    RuleEngine.prototype.execute = function(fact, callback) {
        //these new attributes have to be in both last session and current session to support
        // the compare function
        var complete = false;
        fact.result = true;
        var session = _.clone(fact);
        var lastSession = _.clone(fact);
        var _rules = this.activeRules;
        var matchPath = [];
        var ignoreFactChanges = this.ignoreFactChanges;

        (function FnRuleLoop(x) {
            var API = {
                "rule": function() { return _rules[x]; },
                "when": function(outcome) {
                    if (outcome) {
                        var _consequence = _rules[x].consequence;
                        _consequence.ruleRef = _rules[x].id || _rules[x].name || 'index_'+x;
                        process.nextTick(function() {
                            matchPath.push(_consequence.ruleRef);
                            _consequence.call(session, API, session);
                        });
                    } else {
                        process.nextTick(function() {
                            API.next();
                        });
                    }
                },
                "restart": function() {
                    return FnRuleLoop(0);
                },
                "stop": function() {
                    complete = true;
                    return FnRuleLoop(0);
                },
                "next": function() {
                    if (!ignoreFactChanges && !_.isEqual(lastSession, session)) {
                        lastSession = _.clone(session);
                        process.nextTick(function() {
                            API.restart();
                        });
                    } else {
                        process.nextTick(function() {
                            return FnRuleLoop(x + 1);
                        });
                    }
                }
            };

            if (x < _rules.length && complete === false) {
                var _condition = _rules[x].condition;

                if (_.isFunction(_condition))
                    _condition.call(session, API, session);
                else
                    API.when(checkConditions(session, _condition, true));
            } else {
                process.nextTick(function() {
                    session.matchPath = matchPath;
                    return callback(session);
                });
            }
        })(0);
    };

    RuleEngine.prototype.findRules = function(filter) {
        if (typeof(filter) === "undefined") {
            return this.rules;
        } else {
            var find = _.matches(filter);
            return _.filter(this.rules, find);
        }
    }

    RuleEngine.prototype.turn = function(state, filter) {
        var state = (state === "on" || state === "ON") ? true : false;
        var rules = this.findRules(filter);
        for (var i = 0, j = rules.length; i < j; i++) {
            rules[i].on = state;
        }
        this.sync();
    }

    RuleEngine.prototype.prioritize = function(priority, filter) {
        priority = parseInt(priority, 10);
        var rules = this.findRules(filter);
        for (var i = 0, j = rules.length; i < j; i++) {
            rules[i].priority = priority;
        }
        this.sync();
    }

    RuleEngine.prototype.toJSON = function() {
        var rules = this.rules;
        if (rules instanceof Array) {
            rules = rules.map(function(rule) {
                rule.condition = rule.condition.toString();
                rule.consequence = rule.consequence.toString();
                return rule;
            });
        } else if (typeof(rules) != "undefined") {
            rules.condition = rules.condition.toString();
            rules.consequence = rules.consequence.toString();
        }
        return rules;
    };

    RuleEngine.prototype.fromJSON = function(rules) {
        this.init();
        if (typeof(rules) == "string") {
            rules = JSON.parse(rules);
        }
        if (rules instanceof Array) {
            rules = rules.map(function(rule) {
                rule.condition = eval("(" + rule.condition + ")");
                rule.consequence = eval("(" + rule.consequence + ")");
                return rule;
            });
        } else if (rules !== null && typeof(rules) == "object") {
            rules.condition = eval("(" + rules.condition + ")");
            rules.consequence = eval("(" + rules.consequence + ")");
        }
        this.register(rules);
    };

    module.exports = RuleEngine;
}(module.exports));
