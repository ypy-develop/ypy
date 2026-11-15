// SPDX-License-Identifier: MIT

package bench

import (
	"github.com/chromedp/cdproto/profiler"
	"github.com/chromedp/cdproto/runtime"
)

// profilerFixture is a tiny CPU profile of 1 ms samples: one in the harness,
// two in parse (called by swap), one in swap itself and two idle.
func profilerFixture() *profiler.Profile {
	frame := func(name, url string, line int64) *runtime.CallFrame {
		return &runtime.CallFrame{FunctionName: name, URL: url, LineNumber: line}
	}
	nodes := []*profiler.ProfileNode{
		{ID: 1, CallFrame: frame("(root)", "", 0), Children: []int64{2, 3, 6}},
		{ID: 2, CallFrame: frame("run", "http://127.0.0.1:1/scenarios.js", 4)},
		{ID: 3, CallFrame: frame("swap", "http://127.0.0.1:1/build.js", 5), Children: []int64{4}},
		{ID: 4, CallFrame: frame("parse", "http://127.0.0.1:1/build.js", 10)},
		{ID: 6, CallFrame: frame("(idle)", "", 0)},
	}
	// the delta that follows a sample is the time it covers
	return &profiler.Profile{
		Nodes:      nodes,
		Samples:    []int64{2, 4, 4, 3, 6, 6},
		TimeDeltas: []int64{0, 1000, 1000, 1000, 1000, 1000, 1000},
	}
}
