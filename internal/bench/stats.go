// SPDX-License-Identifier: MIT

package bench

import (
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

// percentile is the nearest-rank percentile of values; p is in [0, 1].
func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return math.NaN()
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	rank := int(math.Ceil(p*float64(len(sorted)))) - 1
	rank = max(0, min(len(sorted)-1, rank))
	return sorted[rank]
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return math.NaN()
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

func mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func stdev(values []float64) float64 {
	m := mean(values)
	sq := make([]float64, len(values))
	for i, v := range values {
		sq[i] = (v - m) * (v - m)
	}
	return math.Sqrt(mean(sq))
}

// summarize turns the samples of one metric into its summary. rounds holds one
// slice of samples per fresh page: the summary pools them and keeps the median
// of every round, so the noise between rounds (the state of the machine and of
// the JIT) is visible next to the result. noisePct is the interquartile range
// of the round medians, relative to the pooled median: one bad round does not
// move it, a machine that is never steady does.
func summarize(rounds [][]float64) Metric {
	var all []float64
	roundMedians := make([]float64, 0, len(rounds))
	for _, r := range rounds {
		all = append(all, r...)
		roundMedians = append(roundMedians, median(r))
	}
	med := median(all)
	noise := 0.0
	if len(roundMedians) > 2 && med > 0 {
		noise = (percentile(roundMedians, 0.75) - percentile(roundMedians, 0.25)) / med * 100
	}
	m := mean(all)
	cv := 0.0
	if m > 0 {
		cv = stdev(all) / m * 100
	}
	lower := true
	lo := math.Inf(1)
	for _, v := range all {
		lo = math.Min(lo, v)
	}
	return Metric{
		LowerIsBetter: &lower,
		N:             len(all),
		Median:        med,
		P95:           percentile(all, 0.95),
		Min:           lo,
		Mean:          m,
		CV:            cv,
		RoundMedians:  roundMedians,
		NoisePct:      noise,
	}
}

// exactMetric is a metric that has one exact value (a size).
func exactMetric(unit string, v float64) Metric {
	lower := true
	return Metric{Unit: unit, LowerIsBetter: &lower, N: 1, Median: v, P95: v, Min: v, Mean: v, RoundMedians: []float64{v}}
}

// toFixed formats v with digits decimals the way JavaScript's toFixed does:
// the nearest value, the larger one on an exact tie.
func toFixed(v float64, digits int) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	r := new(big.Rat).SetFloat64(v)
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	r.Mul(r, new(big.Rat).SetInt(scale))
	r.Add(r, big.NewRat(1, 2))
	// floor of r
	n := new(big.Int).Div(r.Num(), r.Denom()) // Euclidean division: floor for a positive denominator
	neg := n.Sign() < 0
	s := new(big.Int).Abs(n).String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// formatNum is the compact number format of the tables: about 3 significant
// digits, thousands separated by commas.
func formatNum(v float64) string {
	if math.IsNaN(v) {
		return "-"
	}
	abs := math.Abs(v)
	switch {
	case abs == 0:
		return "0"
	case abs >= 1000:
		return groupThousands(toFixed(v, 0))
	case abs >= 100:
		return toFixed(v, 0)
	case abs >= 10:
		return toFixed(v, 1)
	case abs >= 1:
		return toFixed(v, 2)
	}
	return toFixed(v, 3)
}

func groupThousands(s string) string {
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign, s = "-", s[1:]
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return sign + b.String()
}

// table renders rows as an aligned text table; the first row is the header.
// align holds 'l' for a left aligned column, anything else (or nothing) is right.
func table(rows [][]string, align string) string {
	if len(rows) == 0 {
		return ""
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for c, cell := range row {
			if n := len([]rune(cell)); n > widths[c] {
				widths[c] = n
			}
		}
	}
	line := func(row []string) string {
		cells := make([]string, len(row))
		for c, cell := range row {
			pad := strings.Repeat(" ", widths[c]-len([]rune(cell)))
			if c < len(align) && align[c] == 'l' {
				cells[c] = cell + pad
			} else {
				cells[c] = pad + cell
			}
		}
		return strings.Join(cells, "  ")
	}
	dashes := make([]string, len(widths))
	for c, w := range widths {
		dashes[c] = strings.Repeat("-", w)
	}
	out := []string{line(rows[0]), strings.Join(dashes, "  ")}
	for _, row := range rows[1:] {
		out = append(out, line(row))
	}
	return strings.Join(out, "\n")
}
