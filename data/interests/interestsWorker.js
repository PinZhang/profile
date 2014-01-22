/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

importScripts("interestsTextClassifier.js");

function InterestsWorkerError(message) {
    this.name = "InterestsWorkerError";
    this.message = message || "InterestsWorker has errored";
}

function log(msg) {
  dump("-*- interestsWorker -*- " + msg + '\n')
}

InterestsWorkerError.prototype = new Error();
InterestsWorkerError.prototype.constructor = InterestsWorkerError;

let gNamespace = null;
let gRegionCode = null;
let gTokenizer = null;
let gClassifier = null;
let gInterestsData = null;
let gInterestsDataInRegExp = null;

const kSplitter = /[^-\w\xco-\u017f\u0380-\u03ff\u0400-\u04ff]+/;

// bootstrap the worker with data and models
function bootstrap(aMessageData) {
  // expects : {interestsData, interestsDataType, interestsClassifierModel, interestsUrlStopwords, workerRegionCode}

  gRegionCode = aMessageData.workerRegionCode;

  if (aMessageData.interestsUrlStopwords) {
    gTokenizer = new PlaceTokenizer({
      urlStopwordSet: aMessageData.interestsUrlStopwords,
      model: aMessageData.interestsData,
      regionCode: gRegionCode
    });
  }

  if (aMessageData.interestsClassifierModel) {
    gClassifier = new NaiveBayesClassifier(aMessageData.interestsClassifierModel);
  }

  gNamespace = aMessageData.workerNamespace;

  swapRules(aMessageData);

  self.postMessage({
    message: "bootstrapComplete"
  });
}

// Only support regexp with wildcard
function buildMappingWithWildcard() {
  gInterestsDataInRegExp = [];

  Object.keys(gInterestsData).forEach(function(domain) {
    if (domain.indexOf("*") < 0)
      return;

    gInterestsDataInRegExp.push(domain);
  });
}

function getMatchedHostRule(host) {
  if (gInterestsData[host])
    return gInterestsData[host];

  for (let exp in gInterestsDataInRegExp) {
    let re = new RegExp("^" + exp.replace("*", ".+") + "$", "i");
    if (re.test(host))
      return gInterestsDataInRegExp(exp);
  }

  return null;
}

// swap out rules
function swapRules({interestsData, interestsDataType}) {
  if (interestsDataType == "dfr") {
    gInterestsData = interestsData;
    buildMappingWithWildcard();
  }
}

// classify a page using rules
function ruleClassify({host, language, tld, metaData, path, title, url}) {
  if (gInterestsData == null) {
    return [];
  }
  let interests = [];

  let matchedHost = getMatchedHostRule(host);
  let hostKeys = matchedHost ? Object.keys(matchedHost).length : 0;

  let matchedTLD = host != tld ? getMatchedHostRule(tld) : matchedHost;
  let tldKeys = (host != tld && matchedTLD) ? Object.keys(matchedTLD).length : 0;

  if (hostKeys || tldKeys) {
    // process __ANY first
    if (hostKeys && matchedHost["__ANY"]) {
      interests = interests.concat(matchedHost["__ANY"]);
      hostKeys--;
    }
    if (tldKeys && matchedTLD["__ANY"]) {
      interests = interests.concat(matchedTLD["__ANY"]);
      tldKeys--;
    }

    // process keywords
    if (hostKeys || tldKeys) {
      // Split on non-dash, alphanumeric, latin-small, greek, cyrillic
      let words = (url + " " + title).toLowerCase().split(kSplitter);

      let matchedAllTokens = function(tokens) {
        return tokens.every(function(word) {
          return words.indexOf(word) != -1;
        });
      }

      let processDFRKeys = function(hostObject) {
        Object.keys(hostObject).forEach(function(key) {
          if (key == "__HOME" && (path == null || path == "" || path == "/" || path.indexOf("/?") == 0)) {
            interests = interests.concat(hostObject[key]);
          }
          else if (key != "__ANY" && matchedAllTokens(key.split(kSplitter))) {
            interests = interests.concat(hostObject[key]);
          }
        });
      }

      if (hostKeys) {
        processDFRKeys(matchedHost);
      }
      if (tldKeys) {
        processDFRKeys(matchedTLD);
      }
    }
  }
  return interests;
}

// classify a page using text
function textClassify({url, title}) {
  if (gTokenizer == null || gClassifier == null) {
    return [];
  }

  let tokens = gTokenizer.tokenize(url, title);
  let interest = gClassifier.classify(tokens);

  if (interest != null) {
    return interest;
  }
  return [];
}

// Figure out which interests are associated to the document
function getInterestsForDocument(aMessageData) {
  function dedupeInterests(interests) {
    // remove duplicates
    if (interests.length > 1) {
      // insert interests into hash and reget the keys
      let theHash = {};
      interests.forEach(function(aInterest) {
        if (!theHash[aInterest]) {
          theHash[aInterest]=1;
        }
      });
      interests = Object.keys(theHash);
    }
    return interests;
  };

  aMessageData.message = "InterestsForDocument";
  aMessageData.namespace = gNamespace;

  // we need to submit 3 messages
  // - for rule classification
  // - for keyword classification
  // - for combined classification
  let interests = [];
  let results = [];
  try {
    interests = ruleClassify(aMessageData);
    results.push({type: "rules", interests: dedupeInterests(interests)});

    let rulesWorked = interests.length > 0;
    if (rulesWorked) {
      results.push({type: "combined", interests: dedupeInterests(interests)});
    }

    interests = textClassify(aMessageData);
    results.push({type: "keywords", interests: dedupeInterests(interests)});
    if (!rulesWorked) {
      results.push({type: "combined", interests: dedupeInterests(interests)});
    }
    aMessageData.results = results;
    self.postMessage(aMessageData);
  }
  catch (ex) {
    log("getInterestsForDocument: " + ex)
  }
}

// Dispatch the message to the appropriate function
self.onmessage = function({data}) {
  self[data.message](data);
};

