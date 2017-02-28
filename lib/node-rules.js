(function() {
    'use strict';
    var _ = require('underscore');
    exports.version = '3.0.0';

    function RuleEngine(rules, options) {
        this.init();

        if (typeof(rules) != "undefined") {
            this.register(rules);
        }

        options = _.extend({ ignoreFactChanges: true }, options);
        this.ignoreFactChanges = options.ignoreFactChanges;

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
            return _.isObject(memo) ? memo[prop] : undefined;
        }, obj);
    };

    var bury = function (obj, properties, value) {
        return _.reduce(properties.split('.'), function (memo, prop, i, parts) {
            if (i === parts.length - 1) return memo[prop] = value;
            return _.isObject(memo[prop]) ? memo[prop] : (memo[prop] = {});
        }, obj);
    };

    var compileValue = function (facts, value) {
        if (!_.isObject(value)) return value;
        if (value.$field) return dig(facts, value.$field);
        return undefined;
    };

    var testFact = function (facts, key, operations) {
        var fact = dig(facts, key);

        var value = compileValue(facts, operations);
        if (value != undefined) return fact === value;

        var isAnd = !operations.$or;
        operations = operations.$or || operations.$and || operations;

        return _[isAnd ? 'all' : 'any'](operations.$or || operations, function (uncompiledValue, key) {
            var value = compileValue(facts, uncompiledValue);
            switch (key) {
            case '$lt': return fact < value;
            case '$lte': return fact <= value;
            case '$eq': return fact === value;
            case '$gte': return fact >= value;
            case '$gt': return fact > value;
            case '$ne': return fact !== value;
            case '$between': return value[0] <= fact <= value[1];
            case '$notBetween': return fact < value[0] || value[1] < fact;
            case '$in': return value.includes(fact);
            case '$notIn': return !value.includes(fact);
            case '$match': return !!fact.match(value);
            case '$notMatch': return !fact.match(value);
            default: throw 'invalid operator';
            }
        });
    };

    var checkConditions = function (facts, conditions, isAnd) {
        if (_.isArray(conditions)) {
            return _[isAnd ? 'all' : 'any'](conditions, function (subConds, key) {
                return checkConditions(facts, subConds, true);
            });
        } else {
            return _[isAnd ? 'all' : 'any'](_.pairs(conditions), function (pair, i) {
                var key = pair[0];
                var subConds = pair[1];
                if (key == '$or') return checkConditions(facts, subConds, false);
                if (key == '$and') return checkConditions(facts, subConds, true);
                return testFact(facts, key, subConds);
            });
        }
    };

    var updateFact = function (facts, key, operations) {
        var fact = dig(facts, key);
        var value = compileValue(facts, operations);
        if (value != undefined) return bury(facts, key, value);

        _.each(_.isArray(operations) ? operations : [operations], function (subOps, i) {
            _.each(subOps, function (uncompiledValue, opKey) {
                var value = compileValue(facts, uncompiledValue);

                switch (opKey) {
                case '$set': return bury(facts, key, value);
                case '$add': return bury(facts, key, fact + value);
                case '$sub': return bury(facts, key, fact - value);
                case '$mul': return bury(facts, key, fact * value);
                case '$div': return bury(facts, key, fact / value);
                // TODO? implement custom operators with a global operator register
                } 

                throw 'invalid consequence operator';
            });
        });
    };

    var doConsequences = function (facts, consequences) {
        var mustStop = false;
        _.each(consequences, function (subCons, key) {
            if (_.isArray(consequences)) mustStop = mustStop || doConsequences(facts, subCons);
            else if (key === '$stop') mustStop = true;
            else updateFact(facts, key, subCons);
        });
        return mustStop;
    };

    RuleEngine.prototype.execute = function(fact, callback) {
        //these new attributes have to be in both last session and current session to support
        // the compare function
        var complete = false;
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
                        var _consequence = _rules[x].consequence || _rules[x].consequences;
                        _consequence.ruleRef = _rules[x].id || _rules[x].name || 'index_'+x;

                        process.nextTick(function() {
                            matchPath.push(_consequence.ruleRef);

                            if (_.isFunction(_consequence))
                                _consequence.call(session, API, session);
                            else {
                                delete _consequence.ruleRef;
                                var mustStop = doConsequences(session, _consequence);
                                API[mustStop ? 'stop' : 'next']();
                            }
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
                var _condition = _rules[x].condition || _rules[x].conditions;

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
