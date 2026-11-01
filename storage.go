package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxSnapshotBytes = 16 << 20

var httpClient = &http.Client{Timeout: 45 * time.Second}

func decodeSnapshot(r io.Reader) (Snapshot, error) {
	var s Snapshot
	data, err := io.ReadAll(io.LimitReader(r, maxSnapshotBytes+1))
	if err != nil {
		return s, err
	}
	if len(data) > maxSnapshotBytes {
		return s, errors.New("snapshot exceeds 16 MiB")
	}
	if err = json.Unmarshal(data, &s); err != nil {
		return s, err
	}
	return s, validateSnapshot(s, time.Now())
}
func gcsRequest(ctx context.Context, method, endpoint string, body io.Reader) (*http.Response, error) {
	tokenReq, _ := http.NewRequestWithContext(ctx, "GET", "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	tokenReq.Header.Set("Metadata-Flavor", "Google")
	tr, err := httpClient.Do(tokenReq)
	if err != nil {
		return nil, err
	}
	defer tr.Body.Close()
	if tr.StatusCode != 200 {
		return nil, errors.New("runtime identity token unavailable")
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err = json.NewDecoder(tr.Body).Decode(&token); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	return httpClient.Do(req)
}
func snapshotObject() string {
	if o := os.Getenv("SNAPSHOT_OBJECT"); o != "" {
		return o
	}
	return "availability/latest.json"
}
func loadSnapshot(ctx context.Context) (*Snapshot, error) {
	var r io.ReadCloser
	if bucket := os.Getenv("SNAPSHOT_BUCKET"); bucket != "" {
		endpoint := "https://storage.googleapis.com/storage/v1/b/" + url.PathEscape(bucket) + "/o/" + url.PathEscape(snapshotObject()) + "?alt=media"
		resp, err := gcsRequest(ctx, "GET", endpoint, nil)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("snapshot storage status %d", resp.StatusCode)
		}
		r = resp.Body
	} else if path := os.Getenv("SNAPSHOT_FILE"); path != "" {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	} else {
		return nil, nil
	}
	s, err := decodeSnapshot(r)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

type snapshotCache struct {
	sync.Mutex
	snapshot *Snapshot
	lastRead time.Time
	state    string
}

func (c *snapshotCache) read(ctx context.Context) (*Snapshot, string) {
	c.Lock()
	defer c.Unlock()
	if time.Since(c.lastRead) < time.Minute {
		return c.snapshot, c.state
	}
	c.lastRead = time.Now()
	s, err := loadSnapshot(ctx)
	if err != nil {
		c.state = "error"
		return c.snapshot, c.state
	}
	c.snapshot = s
	c.state = "ready"
	if s == nil {
		c.state = "not_connected"
	}
	return c.snapshot, c.state
}
func refresh(ctx context.Context) error {
	feed := os.Getenv("AWARD_FEED_URL")
	if feed == "" {
		return errors.New("AWARD_FEED_URL must point to an authorized ANA Mileage Club snapshot adapter; no ANA collector is connected")
	}
	u, err := url.Parse(feed)
	if err != nil || u.Scheme != "https" {
		return errors.New("feed must use HTTPS")
	}
	// Never forward an authorization header through an upstream redirect.
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, "GET", feed, nil)
	if key := os.Getenv("AWARD_FEED_TOKEN"); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("source returned %d; previous snapshot retained", resp.StatusCode)
	}
	s, err := decodeSnapshot(resp.Body)
	if err != nil {
		return err
	}
	if time.Since(s.GeneratedAt) > 26*time.Hour {
		return errors.New("source snapshot is stale; previous snapshot retained")
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if bucket := os.Getenv("SNAPSHOT_BUCKET"); bucket != "" {
		endpoint := "https://storage.googleapis.com/upload/storage/v1/b/" + url.PathEscape(bucket) + "/o?uploadType=media&name=" + url.QueryEscape(snapshotObject())
		result, err := gcsRequest(ctx, "POST", endpoint, bytes.NewReader(data))
		if err != nil {
			return err
		}
		defer result.Body.Close()
		if result.StatusCode < 200 || result.StatusCode >= 300 {
			return fmt.Errorf("snapshot upload status %d", result.StatusCode)
		}
	} else if path := os.Getenv("SNAPSHOT_FILE"); path != "" {
		tmp, err := os.CreateTemp(filepath.Dir(path), ".snapshot-*")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		if _, err = tmp.Write(data); err != nil {
			tmp.Close()
			return err
		}
		if err = tmp.Close(); err != nil {
			return err
		}
		if err = os.Rename(tmp.Name(), path); err != nil {
			return err
		}
	} else {
		return errors.New("configure durable SNAPSHOT_BUCKET or local SNAPSHOT_FILE")
	}
	return nil
}
