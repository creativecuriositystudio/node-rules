(function() {
    'use strict';

    exports.version = '7.1.0-cc';

    var _ = require('underscore');
    var moment = require('moment');

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

    // Clone the given value recursively
    var cloneDeep = function (val) {
        return _.isArray(val) ? val.map(function (val) { return cloneDeep(val); }) :
          _.isDate(val) ? new Date(val) :
          _.isRegExp(val) ? new RegExp(val) :
          _.isObject(val) ? _.mapObject(val, cloneDeep) :
          val === undefined || val === null ? val :
          val.__proto__.constructor(val);
    };

    var pathParts = function (prop) {
        return _.isString(prop) ? prop.split(/\.|\[/) :
            _.isArray(prop) ? prop :
            [prop];
    };

    var dig = function (obj, prop) {
        return _.reduce(
            pathParts(prop),
            function (memo, prop) {
                if (!(prop || prop === 0) || !_.isObject(memo))
                    throw new Error('Invalid property: ' + prop);

                var value = memo[_.isString(prop) && prop[prop.length - 1] === ']' ? +prop.slice(0, prop.length - 1) : prop];
                if (_.isUndefined(value))
                    throw new Error('Invalid property: ' + prop);

                return value;
            },
            obj);
    };

    var bury = function (obj, prop, value) {
        return _.reduce(
            pathParts(prop),
            function (memo, prop, i, parts) {
                var fullProp = _.isString(prop) && prop[prop.length - 1] === ']' ? +prop.slice(0, prop.length - 1) : prop;
                if (i === parts.length - 1) return memo[fullProp] = value;
                return _.isObject(memo[fullProp]) ? memo[fullProp] : (memo[fullProp] = {});
            },
            obj);
    };


    var compileValue = function (facts, value) {
        if (!_.isObject(value) || _.isArray(value)) return [true, value];

        var key = Object.keys(value)[0];
        switch (key) {
        case '$field': return [true, dig(facts, value.$field)];

        case '$minOf':
        case '$maxOf':
        case '$sumOf':
        case '$avgOf':
            var [isValid, value] = compileValue(facts, value[key]);
            if (!isValid || !_.isObject(value))
                throw new Error('Invalid property for reducer: ' + key);

            switch (key) {
            case '$minOf': return [true, _.min(value)];
            case '$maxOf': return [true, _.max(value)];
            case '$sumOf': return [true, value.reduce(function (a, b) { return a + b; }, 0)];
            case '$avgOf': return [true, value.length ? value.reduce(function (a, b) { return a + b; }) / value.length : null];
            }

        case '$millisecondsBetween':
        case '$secondsBetween':
        case '$minutesBetween':
        case '$hoursBetween':
        case '$daysBetween':
        case '$weeksBetween':
        case '$monthsBetween':
        case '$quartersBetween':
        case '$yearsBetween':
            var dates = value[key];
            if (!_.isArray(dates) || dates.length < 2)
                throw new Error('Invalid property for date diff: ' + key);

            var [isValid, a] = compileValue(facts, dates[0]);
            if (!isValid || !(a === 'now' || moment(a).isValid()))
                throw new Error('Invalid property for date diff: ' + key);

            var [isValid, b] = compileValue(facts, dates[1]);
            if (!isValid || !(b === 'now' || moment(b).isValid()))
                throw new Error('Invalid property for date diff: ' + key);

            return [true, moment(a === 'now' ? undefined : a).diff(b === 'now' ? undefined : b, key.slice(1, -7), dates[2])];
        }

        return [false];
    };

    var checkConditions = function (facts, conds, isAnd) {
        if (_.isArray(conds)) {
            return _[isAnd ? 'all' : 'any'](conds, function (subConds, key) {
                return checkConditions(facts, subConds, true);
            });
        }

        return _[isAnd ? 'all' : 'any'](_.pairs(conds), function (pair, i) {
            var key = pair[0];
            var subConds = pair[1];

            switch (key) {
            case '$and': return checkConditions(facts, subConds, true);
            case '$or': return checkConditions(facts, subConds, false);
            case '$not': return !checkConditions(facts, subConds, isAnd);
            }

            var [isValue, value] = compileValue(facts, subConds);

            if (key[0] === '$') {
                if (!isValue) throw new Error('Invalid property for operator: ' + key);

                switch (key) {
                case '$ne': return facts != value;
                case '$lt': return facts < value;
                case '$lte': return facts <= value;
                case '$gte': return facts >= value;
                case '$gt': return facts > value;
                case '$between': return value[0] <= facts <= value[1];
                case '$has':
                case '$contains': return facts.includes(value);
                case '$in': return value.includes(facts);
                case '$match': return !!facts.match(value);
                default: throw new Error('Invalid condition operator: ' + key);
                }
            }

            var reducer;
            if (key.includes('#')) [key, reducer] = key.split('#', 2);

            try { var fact = key ? dig(facts, key) : facts; }
            catch (err) {
              if (err.message.includes('Invalid property')) return false;
              else throw err;
            }

            if (!_.isUndefined(reducer)) {
                if (!_.isObject(fact)) throw new Error('Invalid property for reducer: #' + reducer);
                switch (reducer) {
                case 'min': fact = _.min(fact); break;
                case 'max': fact = _.max(fact); break;
                case 'sum': fact = fact.reduce(function (a, b) { return a + b; }, 0); break;
                case 'avg': fact = fact.length ? fact.reduce(function (a, b) { return a + b; }, 0) / fact.length : null; break;
                default: throw new Error('Invalid reducer: #' + reducer);
                }
            }

            // FIXME? should this be isValid?
            return value !== undefined ? fact == value : checkConditions(fact, subConds, true);
        });
    };

    var updateFact = function (facts, key, operations) {
        var [isValue, value] = compileValue(facts, operations);
        if (isValue) return bury(facts, key, value);

        var fact = dig(facts, key);

        _.each(_.isArray(operations) ? operations : [operations], function (subOps, i) {
            if (subOps.$each) {
                return _.each(fact, function (subFact, subKey) {
                    if (!subOps.$where || checkConditions(subFact, subOps.$where, true))
                        updateFact(facts, _.isString(subKey) ? key + '.' + subKey : key + '[' + subKey + ']', subOps.$each);
                });
            }

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
        return rule.id || rule.name || 'index_' + index;
    };

    var doExecute = function (session, rules, ignoreFactChanges) {
        // These new attributes have to be in both last session and current session to support the compare function
        var lastSession = cloneDeep(session);
        var complete = false;
        var matchPath = [];
        return new Promise(function (resolve, reject) {
            (function FnRuleLoop(x) {
                var API = {
                    "rule": function() { return rules[x]; },
                    "when": function(outcome) {
                        if (outcome) {
                            var consequence = rules[x].consequence || rules[x].consequences;
                            var ruleRef = getRuleRef(rules[x], x);

                            process.nextTick(function () {
                                try {
                                    matchPath.push(ruleRef);

                                    if (_.isFunction(consequence)) {
                                        consequence.ruleRef = ruleRef;
                                        consequence.call(session, API, session);
                                    } else {
                                        try {
                                            var mustStop = doConsequences(session, consequence);
                                        } catch (err) {
                                            err.ruleRef = ruleRef;
                                            err.matchPath = matchPath;
                                            err.session = session;
                                            err.consequences = consequence;
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
                            lastSession = cloneDeep(session);
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

                if (x < rules.length && complete === false) {
                    var condition = rules[x].condition || rules[x].conditions;
                    var ruleRef = getRuleRef(rules[x], x);

                    if (_.isFunction(condition))
                        condition.call(session, API, session);
                    else {
                        try {
                            API.when(checkConditions(session, condition, true));
                        } catch (err) {
                            err.ruleRef = ruleRef;
                            err.matchPath = matchPath;
                            err.session = session;
                            err.conditions = condition;
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

    RuleEngine.prototype.execute = function (fact, forEach) {
        var rules = this.activeRules;
        var ignoreFactChanges = this.ignoreFactChanges;

        if (forEach) {
            // Extract global fact if it's been passed
            var globalFact = {};
            if (_.isObject(_.last(forEach))) {
                globalFact = cloneDeep(_.last(forEach));
                forEach = _.initial(forEach);
            }

            // Generate permutations of fact based on values referenced in forEach and execute each in turn
            var count = 0;
            var facts = _.reduce(
                _.isArray(forEach) ? forEach : [forEach],
                function (perms, path) {
                    return _.chain(perms)
                        .map(function (perm) {
                            try { var objs = dig(perm, path); }
                            catch (err) {
                              if (!err.message.includes('Invalid property')) throw err;
                            }

                            objs = (!_.isArray(objs) ? [objs] : objs).filter(function (o) { return !_.isUndefined(o); });
                            count += objs.length;

                            return (objs.length ? objs : [undefined]).map(function (obj) {
                                var newPerm = cloneDeep(perm);
                                bury(newPerm, path, obj);
                                return newPerm;
                            });
                        })
                        .flatten()
                        .value();
                },
                [cloneDeep(fact)]);

            if (!count) facts = [];

            return Promise.all(facts.map(function (fact) {
                fact._global = globalFact;
                return doExecute(fact, rules, ignoreFactChanges);
            }));
        }

        return doExecute(cloneDeep(fact), rules, ignoreFactChanges);
    };

    RuleEngine.prototype.findRules = function(filter) {
        if (typeof(filter) === "undefined") {
            return this.rules;
        } else {
            var find = _.matches(filter);
            return _.filter(this.rules, find);
        }
    };

    RuleEngine.prototype.turn = function(state, filter) {
        state = (state === "on" || state === "ON") ? true : false;
        var rules = this.findRules(filter);
        for (var i = 0, j = rules.length; i < j; i++) {
            rules[i].on = state;
        }
        this.sync();
    };

    RuleEngine.prototype.prioritize = function(priority, filter) {
        priority = parseInt(priority, 10);
        var rules = this.findRules(filter);
        for (var i = 0, j = rules.length; i < j; i++) {
            rules[i].priority = priority;
        }
        this.sync();
    };

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
