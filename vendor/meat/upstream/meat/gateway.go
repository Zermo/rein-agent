package meat

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"time"
)

// exeDevMarkerPath exists on exe.dev VMs. Its presence is how we cheaply decide
// whether to attempt gateway discovery at all. It is a var so tests can override
// it.
var exeDevMarkerPath = "/exe.dev"

// reflectionIntegrationsURL is the exe.dev reflection endpoint that lists the
// integrations attached to this VM. It is a var so tests can point it at a stub.
var reflectionIntegrationsURL = "https://reflection.int.exe.xyz/integrations"

// discoverExeGatewayBase returns the bare origin of the exe.dev managed LLM
// gateway for this VM (e.g. "https://llm.int.exe.xyz"), or "" if we are not on
// an exe.dev VM or no LLM integration is attached.
//
// On exe.dev, an attached "llm" integration proxies the Anthropic API with
// managed credentials injected at the network edge, so no API key needs to live
// on the VM. We discover the integration's hostname via the reflection endpoint,
// exactly as Shelley does.
func discoverExeGatewayBase(ctx context.Context, httpc *http.Client) string {
	if _, err := os.Stat(exeDevMarkerPath); err != nil {
		return ""
	}
	if httpc == nil {
		httpc = &http.Client{Timeout: 5 * time.Second}
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reflectionIntegrationsURL, nil)
	if err != nil {
		return ""
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var body struct {
		Integrations []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Team bool   `json:"team,omitempty"`
		} `json:"integrations"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return ""
	}

	for _, i := range body.Integrations {
		if i.Type != "llm" || i.Name == "" {
			continue
		}
		host := i.Name + ".int.exe.xyz"
		if i.Team {
			host = i.Name + ".team.exe.xyz"
		}
		return "https://" + host
	}
	return ""
}
