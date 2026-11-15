// SPDX-License-Identifier: MIT

package testrun

import "runtime"

func numCPU() int { return runtime.NumCPU() }
