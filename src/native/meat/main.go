// Rein's WebAssembly host for the pinned Meat engine. The host supplies model
// inference and scoped reads; Meat retains its plan validation and chunking.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"syscall/js"

	"meat.dev/meat"
)

type reply struct { value string; err error }

func request(ctx context.Context, kind string, payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil { return "", err }
	ch := make(chan reply, 1)
	var callback js.Func
	callback = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer callback.Release()
		if len(args) > 1 && args[1].String() != "" { ch <- reply{err: fmt.Errorf("%s", args[1].String())} } else { ch <- reply{value: args[0].String()} }
		return nil
	})
	js.Global().Call("reinMeatRequest", kind, string(data), callback)
	select {
	case result := <-ch: return result.value, result.err
	case <-ctx.Done(): return "", ctx.Err()
	}
}

type model struct{}
func (model) Generate(ctx context.Context, system string, messages []meat.Message, tools []meat.Tool) (*meat.Response, error) {
	text, err := request(ctx, "generate", map[string]any{"system": system, "messages": messages, "tools": tools})
	if err != nil { return nil, err }
	var result meat.Response
	if err := json.Unmarshal([]byte(text), &result); err != nil { return nil, err }
	return &result, nil
}

func main() {
	meat.ReinReadTool = func(ctx context.Context, root, name string, input json.RawMessage) (string, bool) {
		text, err := request(ctx, "read", map[string]any{"root": root, "name": name, "input": input})
		if err != nil { return err.Error(), true }
		return text, false
	}
	start := js.FuncOf(func(_ js.Value, args []js.Value) any {
		raw := args[0].String()
		go func() {
			var input struct { Diff string; Root string; MaxTurns int; ChunkBytes int }
			if err := json.Unmarshal([]byte(raw), &input); err != nil { js.Global().Call("reinMeatDone", "", err.Error()); return }
			meat.ReinDiffBudget(input.ChunkBytes)
			result, err := meat.Abridge(context.Background(), model{}, meat.Request{
				RepoRoot: input.Root, UnifiedDiff: input.Diff, MaxTurns: input.MaxTurns,
				Progress: func(text string) { js.Global().Call("reinMeatProgress", text) },
			})
			if err != nil { js.Global().Call("reinMeatDone", "", err.Error()); return }
			data, err := json.Marshal(result)
			if err != nil { js.Global().Call("reinMeatDone", "", err.Error()); return }
			js.Global().Call("reinMeatDone", string(data), "")
		}()
		return nil
	})
	js.Global().Set("reinMeatStart", start)
	select {}
}
