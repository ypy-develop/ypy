// SPDX-License-Identifier: MIT

package browsers

import "encoding/json"

func unmarshalString(raw []byte, out *string) error { return json.Unmarshal(raw, out) }
