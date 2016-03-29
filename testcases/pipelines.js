if (typeof(tests) != "object") {
    tests = [];
}

/**
 * Returns a string of the given size.
 *
 * @param {Number} size - The number of characters in the resulting string.
 */
var getStringOfLength = function() {
    var maxStrLen = 12 * 1024 * 1024;  // May need to be updated if a larger string is needed.
    var hugeStr = new Array(maxStrLen + 1).join("x");
    return function getStringOfLength(size) {
        assert.lte(size, maxStrLen, "Requested size was too large.");
        return hugeStr.substr(0, size);
    };
}();

/**
 * Generates a generic document to use in aggregation pipelines that don't care what the data looks
 * like. These documents are at least 12 KB in size.
 *
 * @param {Number} i - Which number document this is in the collection, monotonically increasing.
 */
function defaultDocGenerator(i) {
    return {
        _id: new ObjectId(),
        string: getStringOfLength(12 * 1024),  // 12 KB.
        sub_docs: [
            {_id: new ObjectId(), x: i, y: i * i}
        ],
        metadata: {
            about: "Used only for performance testing",
            created: new ISODate()
        }
    };
}

/**
 * Returns a function which will populate a collection with 'nDocs' documents, each document
 * generated by calling 'docGenerator' with the document number. Will also create all indices
 * specified in 'indices' on the given collection. Also seeds the random number generator.
 *
 * @param {Object[]} indices - An array of index specifications to be created on the collection.
 * @param {function} docGenerator - A function that takes a document number and returns a document.
 * Used to seed the collection.
 * @param {Number} nDocs - The number of documents to insert into the collection.
 */
function populatorGenerator(nDocs, indices, docGenerator) {
    return function(collection) {
        collection.drop();
        var bulkop = collection.initializeUnorderedBulkOp();
        Random.setRandomSeed(258);

        for (var i = 0; i < nDocs; i++) {
            bulkop.insert(docGenerator(i));
        }
        bulkop.execute();
        indices.forEach(function(indexSpec) {
            assert.commandWorked(collection.ensureIndex(indexSpec));
        });
    };
}

/**
 * Returns a test case object that can be used by {@link #runTests}.
 *
 * @param {Object} options - Options describing the test case.
 * @param {String} options.name - The name of the test case. "Aggregation." will be prepended.
 * @param {Object[]} options.pipeline - The aggregation pipeline to run. If the final stage is not
 * an $out stage (which needs to be the last stage in the pipeline), a final $skip stage, skipping
 * 1,000,000,000 documents, will be added to avoid the overhead of BSON serialization, focusing the
 * test on the stages themselves.
 *
 * @param {String[]} [options.tags=["aggregation", "regression"]] - The tags describing what type of
 * test this is.
 * @param {Object[]} [options.indices=[]] - An array of index specifications to create on the
 * collection.
 * @param {Number} [options.nDocs=500] - The number of documents to insert in the collection.
 * @param {function} [options.docGenerator=defaultDocGenerator] - A function that takes a document
 * number and returns a document. Used to seed the collection. The random number generator will be
 * seeded before the first call.
 * @param {function} [options.pre=populatorGenerator] - A function run before the test starts,
 * intended to set up state necessary for the test to run. For example, creating collections and
 * indices. If this option is specified, the 'docGenerator' and 'indices' options will be ignored.
 * @param {function} [options.post=drop] - A function run after the test completes, intended to
 * clean up any state on the server it may have created during setup or execution. If 'pipeline'
 * uses more than one collection, this will need to drop the other collection(s) involved.
 */
function testCaseGenerator(options) {
    nDocs = options.nDocs || 500;
    var pipeline = options.pipeline;
    if (pipeline.length > 0 && !pipeline[pipeline.length - 1].hasOwnProperty("$out")) {
        pipeline.push({$skip: 1e9});
    }
    return {
        tags: options.tags || ["aggregation", "regression"],
        name: "Aggregation." + options.name,
        pre: options.pre || populatorGenerator(nDocs,
                                               options.indices || [],
                                               options.docGenerator || defaultDocGenerator),
        post: options.post || function(collection) {
            collection.drop();
        },
        ops: [
            {
                op: "command",
                ns: "#B_DB",
                command: {
                    aggregate: "#B_COLL",
                    pipeline: pipeline,
                    cursor: {}
                }
            }
        ]
    };
}

//
// Empty pipeline.
//

tests.push(testCaseGenerator({
    name: "Empty",
    pipeline: []
}));

//
// Single stage pipelines.
//

tests.push(testCaseGenerator({
    name: "GeoNear2d",
    docGenerator: function geoNear2dGenerator(i) {
        return {
            _id: i,
            geo: [
                // Two random values in range [-100, 100).
                Random.randInt(200) - 100,
                Random.randInt(200) - 100
            ],
            boolFilter: i % 2 === 0
        };
    },
    indices: [{geo: "2d"}],
    pipeline: [
        {
            $geoNear: {
                near: [0, 0],
                minDistance: 0,
                maxDistance: 300,
                distanceField: "foo",
                query: {
                    boolFilter: true
                }
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "GeoNear2dSphere",
    indices: [{geo: "2dsphere"}],
    docGenerator: function geoNear2dGenerator(i) {
        return {
            _id: i,
            geo: [
                (Random.rand() * 360) - 180,  // Longitude, in range [-180, 180).
                (Random.rand() * 180) - 90  // Latitude, in range [-90, 90).
            ],
            boolFilter: i % 2 === 0
        };
    },
    pipeline: [
        {
            $geoNear: {
                near: [0, 0],
                minDistance: 0,
                maxDistance: 300,
                distanceField: "foo",
                query: {
                    boolFilter: true
                },
                spherical: true
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "Group.All",
    pipeline: [{$group: {_id: "constant"}}]
}));

tests.push(testCaseGenerator({
    name: "Group.TenGroups",
    docGenerator: function basicGroupDocGenerator(i) {
        return {_id: i, _idMod10: i % 10};
    },
    pipeline: [{$group: {_id: "$_idMod10"}}]
}));

tests.push(testCaseGenerator({
    name: "Group.TenGroupsWithAvg",
    docGenerator: function basicGroupDocGenerator(i) {
        return {_id: i, _idMod10: i % 10};
    },
    pipeline: [{$group: {_id: "$_idMod10", avg: {$avg: "$_id"}}}]
}));

tests.push(testCaseGenerator({
    name: "Limit",
    nDocs: 500,
    pipeline: [{$limit: 250}]
}));

// $lookup tests need two collections, so they use their own setup code.
tests.push(testCaseGenerator({
    name: "Lookup",
    // The setup function is only given one collection, but $lookup needs two. We'll treat the given
    // one as the source collection, and create a second one with the name of the first plus
    // '_lookup', which we'll use to look up from.
    pre: function lookupPopulator(sourceCollection) {
        var lookupCollName = sourceCollection.getName() + "_lookup";
        var lookupCollection = sourceCollection.getDB()[lookupCollName];
        var nDocs = 500;

        sourceCollection.drop();
        lookupCollection.drop();

        var sourceBulk = sourceCollection.initializeUnorderedBulkOp();
        var lookupBulk = lookupCollection.initializeUnorderedBulkOp();
        for (var i = 0; i < nDocs; i++) {
            sourceBulk.insert({_id: i, foreignKey: i});
            lookupBulk.insert({_id: i});
        }
        sourceBulk.execute();
        lookupBulk.execute();
    },
    post: function lookupPost(sourceCollection) {
        var lookupCollName = sourceCollection.getName() + "_lookup";
        var lookupCollection = sourceCollection.getDB()[lookupCollName];
        sourceCollection.drop();
        lookupCollection.drop();
    },
    pipeline: [
        {
            $lookup: {
                from: "#B_COLL_lookup",
                localField: "foreignKey",
                foreignField: "_id",
                as: "match"
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "LookupOrders",
    // The setup function is only given one collection, but $lookup needs two. We'll treat the given
    // one as a collection of orders, and create a second one with the name of the first plus
    // '_lookup', which we'll use as a collection of products, referred to by the orders.
    pre: function lookupPopulator(ordersCollection) {
        var productCollName = ordersCollection.getName() + "_lookup";
        var productsCollection = ordersCollection.getDB()[productCollName];
        var nDocs = 500;

        productsCollection.drop();
        ordersCollection.drop();

        // Insert orders, referencing products.
        Random.setRandomSeed(parseInt("5ca1ab1e", 16));
        var productsBulk = productsCollection.initializeUnorderedBulkOp();
        var ordersBulk = ordersCollection.initializeUnorderedBulkOp();
        for (var i = 0; i < nDocs; i++) {
            // Products are simple, just an _id.
            productsBulk.insert({_id: i});

            // Each order will contain a random number of products in an array.
            var nProducts = Random.randInt(100);
            var products = [];
            for (var p = 0; p < nProducts; p++) {
                products.push({_id: Random.randInt(nDocs), quantity: Random.randInt(20)});
            }

            ordersBulk.insert({
                _id: new ObjectId(),
                products: products,
                ts: new ISODate()
            });
        }
        productsBulk.execute();
        ordersBulk.execute();
    },
    post: function lookupPost(sourceCollection) {
        var lookupCollName = sourceCollection.getName() + "_lookup";
        var lookupCollection = sourceCollection.getDB()[lookupCollName];
        sourceCollection.drop();
        lookupCollection.drop();
    },
    pipeline: [
        {
            $unwind: "$products"
        },
        {
            $lookup: {
                from: "#B_COLL_lookup",
                localField: "products._id",
                foreignField: "_id",
                as: "product"
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "Match",
    nDocs: 500,
    docGenerator: function simpleMatchDocGenerator(i) {
        return {_id: i};
    },
    // Add a $project stage before the $match stage to ensure the $match isn't pushed down to the
    // query layer.
    pipeline: [{$project: {_id: 0, _idTimes10: {$multiply: ["$_id", 10]}}},
               {$match: {_idTimes10: {$lt: 2500}}}]
}));

tests.push(testCaseGenerator({
    name: "Out",
    post: function outCleanup(sourceCollection) {
        var outCollName = sourceCollection.getName() + "_tmp_out";
        var outCollection = sourceCollection.getDB()[outCollName];
        sourceCollection.drop();
        outCollection.drop();
    },
    pipeline: [{$out: "#B_COLL_tmp_out"}]
}));

tests.push(testCaseGenerator({
    name: "Project",
    docGenerator: function simpleProjectionDocGenerator(i) {
        return {_id: i, w: i, x: i, y: i, z: i};
    },
    pipeline: [{$project: {_id: 0, x: 1, y: 1}}]
}));

tests.push(testCaseGenerator({
    name: "Redact",
    docGenerator: function simpleRedactDocGenerator(i) {
        return {_id: i, has_permissions: i % 2 === 0};
    },
    pipeline: [
        {
            $redact: {
                $cond: {
                    if: "$has_permissions",
                    then: "$$DESCEND",
                    else: "$$PRUNE"
                }
            }
        }
    ]
}));

tests.push(testCaseGenerator({
    name: "Sample.SmallSample",
    nDocs: 500,
    pipeline: [{$sample: {size: 5}}]
}));

tests.push(testCaseGenerator({
    name: "Sample.LargeSample",
    nDocs: 500,
    pipeline: [{$sample: {size: 200}}]
}));

tests.push(testCaseGenerator({
    name: "Skip",
    nDocs: 500,
    pipeline: [{$skip: 250}]
}));

tests.push(testCaseGenerator({
    name: "Sort",
    docGenerator: function simpleSortDocGenerator(i) {
        return {_id: i, x: Random.rand()};
    },
    pipeline: [{$sort: {x: 1}}]
}));

tests.push(testCaseGenerator({
    name: "Unwind",
    docGenerator: function simpleUnwindDocGenerator(i) {
        return {
            _id: i,
            array: [1, "some string data", new ObjectId(), null, NumberLong(23), [4, 5], {x: 1}]
        };
    },
    pipeline: [{$unwind: {path: "$array", includeArrayIndex: "index"}}]
}));

//
// Multi-stage pipelines that should be optimized to some extent.
//

tests.push(testCaseGenerator({
    name: "SortWithLimit",
    docGenerator: function simpleSortDocGenerator(i) {
        return {_id: i, x: Random.rand()};
    },
    pipeline: [{$sort: {x: 1}}, {$limit: 10}]
}));

tests.push(testCaseGenerator({
    name: "UnwindThenGroup",
    docGenerator: function simpleUnwindDocGenerator(i) {
        var largeArray = [];
        for (var j = 0; j < 1000; j++) {
            largeArray.push(getStringOfLength(10) + j);
        }
        return {
            _id: i,
            array: largeArray,
            largeString: getStringOfLength(1024 * 1024)
        };
    },
    pipeline: [{$unwind: "$array"}, {$group: {_id: "$array", count: {$sum: 1}}}]
}));