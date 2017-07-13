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
        this.activeRules = _.chain(this.rules)
            .each(function (rule) { _.defaults(rule, { on: true, priority: 0 }); })
            .filter(function (rule) { return rule.on; })
            .sortBy('priority')
            .value()
            .reverse();
    };

    var dig = function (obj, prop) {
        return _.reduce(
            typeof prop === 'string' ? prop.split(/\.|]/) : _.isArray(prop) ? prop : [prop],
            function (memo, prop) {
                if (!(prop || prop === 0) || !_.isObject(memo))
                    throw new Error('Invalid property: ' + prop);

                var value = memo[typeof prop === 'string' && prop[0] === '[' ? +prop.slice(1) : prop];
                if (_.isUndefined(value))
                    throw new Error('Invalid property: ' + prop);

                return value;
            }, obj);
    };

    var bury = function (obj, properties, value) {
        return _.reduce(properties.split('.'), function (memo, prop, i, parts) {
            if (i === parts.length - 1) return memo[prop] = value;
            return _.isObject(memo[prop]) ? memo[prop] : (memo[prop] = {});
        }, obj);
    };

    var compileValue = function (facts, value) {
        if (!_.isObject(value)) return [true, value];
        if (value.$field) return [true, dig(facts, value.$field)];
        return [false];
    };

    var checkConditions = function (facts, obj, isAnd) {
        if (_.isArray(obj)) {
            return _[isAnd ? 'all' : 'any'](obj, function (subObj, key) {
                return checkConditions(facts, subObj, true);
            });
        }

        return _[isAnd ? 'all' : 'any'](_.pairs(obj), function (pair, i) {
            var key = pair[0];
            var subObj = pair[1];

            switch (key) {
            case '$and': return checkConditions(facts, subObj, true);
            case '$or': return checkConditions(facts, subObj, false);
            case '$not': return !checkConditions(facts, subObj, isAnd);
            }

            var [isValue, value] = compileValue(facts, subObj);

            if (key[0] === '$') {
                if (!isValue) throw new Error('Invalid property for: ' + key);

                switch (key) {
                case '$not': return facts != value;
                case '$lt': return facts < value;
                case '$lte': return facts <= value;
                case '$gte': return facts >= value;
                case '$gt': return facts > value;
                case '$between': return value[0] <= facts <= value[1];
                case '$has':
                case '$contains': return value.includes(facts);
                case '$in': return facts.includes(value);
                case '$match': return !!facts.match(value);
                default: throw new Error('Invalid condition operator: ' + key);
                }
            }

            var fact = dig(facts, key);

            if (value !== undefined) return fact == value;

            return checkConditions(fact, subObj, true);
        });
    };

    var updateFact = function (facts, key, operations) {
        var [isValue, value] = compileValue(facts, operations);
        if (isValue) return bury(facts, key, value);

        var fact = dig(facts, key);

        _.each(_.isArray(operations) ? operations : [operations], function (subOps, i) {
            _.each(subOps, function (uncompiledValue, opKey) {
                var [isValue, value] = compileValue(facts, uncompiledValue);
                if (!isValue) throw new Error('Invalid property for: ' + key);

                switch (opKey) {
                case '$add': return bury(facts, key, fact + value);
                case '$sub': return bury(facts, key, fact - value);
                case '$mul': return bury(facts, key, fact * value);
                case '$div': return bury(facts, key, fact / value);
                // TODO? implement custom operators with a global operator register
                }

                throw new Error('Invalid consequence operator: ' + opKey);
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

    var getRuleRef = function (rule, index) {
        return rule.id || rule.name || 'index_' + x;
    };

    RuleEngine.prototype.execute = function (fact) {
        //these new attributes have to be in both last session and current session to support
        // the compare function
        var complete = false;
        var session = _.clone(fact);
        var lastSession = _.clone(fact);
        var _rules = this.activeRules;
        var matchPath = [];
        var ignoreFactChanges = this.ignoreFactChanges;

        return new Promise(function (resolve, reject) {
            (function FnRuleLoop(x) {
                var API = {
                    "rule": function() { return _rules[x]; },
                    "when": function(outcome) {
                        if (outcome) {
                            var _consequence = _rules[x].consequence || _rules[x].consequences;
                            var ruleRef = getRuleRef(_rules[x], x);

                            process.nextTick(function () {
                                try {
                                    matchPath.push(ruleRef);

                                    if (_.isFunction(_consequence)) {
                                        _consequence.ruleRef = ruleRef;
                                        _consequence.call(session, API, session);
                                    } else {
                                        try {
                                            var mustStop = doConsequences(session, _consequence);
                                        } catch (err) {
                                            err.ruleRef = ruleRef;
                                            err.matchPath = matchPath;
                                            err.session = session;
                                            err.consequences = _consequence;
                                            throw err;
                                        }
                                        API[mustStop ? 'stop' : 'next']();
                                    }
                                } catch (err) { reject(err); }
                            });
                        } else {
                            process.nextTick(function() {
                                try {
                                    API.next();
                                } catch (err) { reject(err); }
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
                                try {
                                    API.restart();
                                } catch (err) { reject(err); }
                            });
                        } else {
                            process.nextTick(function() {
                                try {
                                    FnRuleLoop(x + 1);
                                } catch (err) { reject(err); }
                            });
                        }
                    }
                };

                if (x < _rules.length && complete === false) {
                    var _condition = _rules[x].condition || _rules[x].conditions;
                    var ruleRef = getRuleRef(_rules[x], x);

                    if (_.isFunction(_condition))
                        _condition.call(session, API, session);
                    else {
                        try {
                            API.when(checkConditions(session, _condition, true));
                        } catch (err) {
                            err.ruleRef = ruleRef;
                            err.matchPath = matchPath;
                            err.session = session;
                            err.conditions = _condition;
                            throw err;
                        }
                    }
                } else {
                    process.nextTick(function() {
                        try {
                            session.matchPath = matchPath;
                            resolve(session);
                        } catch (err) { reject(err); }
                    });
                }
            })(0);
        });
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
