package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func example(now time.Time, dest string) (Scan, Itinerary) {
	dep := now.Add(10 * 24 * time.Hour)
	it := Itinerary{ID: "test-only", Status: "available", Seats: 2, Miles: 55000, Segments: []Segment{{Origin: "SFO", Destination: "HND", Operator: "NH", Flight: "NH-test", Cabin: "business", Status: "available", Seats: 2, Departure: dep, Arrival: dep.Add(11 * time.Hour)}}}
	if dest == "PVG" {
		it.Segments = append(it.Segments, Segment{Origin: "HND", Destination: "PVG", Operator: "NH", Flight: "NH-connection-test", Cabin: "economy", Status: "available", Seats: 2, Departure: dep.Add(14 * time.Hour), Arrival: dep.Add(17 * time.Hour)})
	}
	return Scan{Date: dep.In(sfoLocation).Format("2006-01-02"), Destination: dest, Status: "complete", CheckedAt: now}, it
}
func TestEligibility(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		dest   string
		mutate func(*Itinerary)
		want   bool
	}{
		{"Tokyo business", "HND", func(*Itinerary) {}, true},
		{"PVG economy connection", "PVG", func(*Itinerary) {}, true},
		{"PVG business connection", "PVG", func(i *Itinerary) { i.Segments[1].Cabin = "business" }, true},
		{"waitlisted itinerary", "HND", func(i *Itinerary) { i.Status = "waitlisted" }, false},
		{"waitlisted connecting leg", "PVG", func(i *Itinerary) { i.Segments[1].Status = "waitlisted" }, false},
		{"non ANA codeshare", "HND", func(i *Itinerary) { i.Segments[0].Operator = "UA" }, false},
		{"economy Pacific", "PVG", func(i *Itinerary) { i.Segments[0].Cabin = "economy" }, false},
		{"unknown seats", "HND", func(i *Itinerary) { i.Seats = 0 }, false},
		{"not enough connecting seats", "PVG", func(i *Itinerary) { i.Segments[1].Seats = 1 }, false},
		{"airport change", "PVG", func(i *Itinerary) { i.Segments[1].Origin = "NRT" }, false},
		{"invalid connection time", "PVG", func(i *Itinerary) { i.Segments[1].Departure = i.Segments[0].Arrival }, false},
		{"unpriced", "HND", func(i *Itinerary) { i.Miles = 0 }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			scan, it := example(now, c.dest)
			c.mutate(&it)
			if got := eligible(it, scan, now, 2); got != c.want {
				t.Fatalf("eligible=%v, want %v", got, c.want)
			}
		})
	}
}
func TestUnknownAndStaleNeverAvailable(t *testing.T) {
	now := time.Now()
	scan, it := example(now, "HND")
	scan.Itineraries = []Itinerary{it}
	s := Snapshot{Version: 1, Program: "ANA Mileage Club", Source: "unit-test fixture", GeneratedAt: now, Scans: []Scan{scan}}
	if err := validateSnapshot(s, now); err != nil {
		t.Fatal(err)
	}
	d := dashboard(&s, now, 1, "ready")
	found := false
	for _, day := range d.Days {
		if day.Date == scan.Date && day.Destination == "HND" {
			found = true
			if day.Status != "available" {
				t.Fatal(day.Status)
			}
		}
	}
	if !found {
		t.Fatal("missing date")
	}
	s.Scans[0].CheckedAt = now.Add(-27 * time.Hour)
	for _, day := range dashboard(&s, now, 1, "ready").Days {
		if day.Status == "available" {
			t.Fatal("stale inventory leaked")
		}
	}
	for _, day := range dashboard(nil, now, 1, "not_connected").Days {
		if day.Status != "unchecked" {
			t.Fatal("unsearched date represented as searched")
		}
	}
	s.Scans[0].CheckedAt = now
	for _, day := range dashboard(&s, now, 1, "error").Days {
		if day.Status == "available" || len(day.Results) > 0 {
			t.Fatal("storage error exposed fresh result")
		}
	}
	s.Program = "United MileagePlus"
	if validateSnapshot(s, now) == nil {
		t.Fatal("partner program accepted as ANA")
	}
}
func TestScanFailureAndExcludedResults(t *testing.T) {
	now := time.Now()
	scan, it := example(now, "PVG")
	for _, status := range []string{"blocked", "error"} {
		scan.Status = status
		scan.Itineraries = []Itinerary{it}
		s := Snapshot{Scans: []Scan{scan}}
		for _, d := range dashboard(&s, now, 1, "ready").Days {
			if d.Date == scan.Date && d.Destination == "PVG" {
				if d.Status != status || len(d.Results) > 0 {
					t.Fatal(d)
				}
			}
		}
	}
	scan.Status = "complete"
	it.Status = "waitlisted"
	scan.Itineraries = []Itinerary{it}
	for _, d := range dashboard(&Snapshot{Scans: []Scan{scan}}, now, 1, "ready").Days {
		if d.Date == scan.Date && d.Destination == "PVG" && d.Status != "excluded" {
			t.Fatal(d)
		}
	}
}
func TestHTTP(t *testing.T) {
	t.Setenv("SNAPSHOT_BUCKET", "")
	t.Setenv("SNAPSHOT_FILE", "")
	h := handler()
	for _, path := range []string{"/", "/app.js", "/style.css", "/healthz", "/api/availability"} {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 200 {
			t.Fatalf("%s: %d", path, r.Code)
		}
	}
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/api/availability", nil))
	var d Dashboard
	if err := json.Unmarshal(r.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Connected || d.State != "not_connected" || len(d.Days) != 356*3 {
		t.Fatal("incorrect empty state")
	}
	for _, path := range []string{"/api/availability?passengers=0", "/api/availability?passengers=bad"} {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 400 {
			t.Fatal("invalid passenger count accepted")
		}
	}
	r = httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/private.json", nil))
	if r.Code != 404 {
		t.Fatal("private path accessible")
	}
}

func TestSnapshotValidation(t *testing.T) {
	now := time.Now()
	scan, it := example(now, "HND")
	scan.Itineraries = []Itinerary{it}
	s := Snapshot{Version: 1, Program: "ANA Mileage Club", Source: "test only", GeneratedAt: now, Scans: []Scan{scan}}
	s.Scans = append(s.Scans, scan)
	if validateSnapshot(s, now) == nil {
		t.Fatal("duplicate dates accepted")
	}
	s.Scans = s.Scans[:1]
	s.Scans[0].Status = "unknown"
	if validateSnapshot(s, now) == nil {
		t.Fatal("unknown scan status accepted")
	}
	if _, err := decodeSnapshot(strings.NewReader("not json")); err == nil {
		t.Fatal("invalid snapshot accepted")
	}
}
func TestLocalStorageAndFailureState(t *testing.T) {
	t.Setenv("SNAPSHOT_BUCKET", "")
	path := filepath.Join(t.TempDir(), "snapshot.json")
	t.Setenv("SNAPSHOT_FILE", path)
	now := time.Now()
	scan, it := example(now, "PVG")
	scan.Itineraries = []Itinerary{it}
	s := Snapshot{Version: 1, Program: "ANA Mileage Club", Source: "test fixture only", GeneratedAt: now, Scans: []Scan{scan}}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	c := &snapshotCache{}
	loaded, state := c.read(context.Background())
	if state != "ready" || loaded == nil {
		t.Fatal(state)
	}
	if err = os.WriteFile(path, []byte("broken JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	c.lastRead = time.Time{}
	cached, state := c.read(context.Background())
	if state != "error" || cached == nil {
		t.Fatal("failure did not preserve snapshot and expose error")
	}
	for _, d := range dashboard(cached, now, 1, state).Days {
		if len(d.Results) > 0 {
			t.Fatal("failed read leaked a positive result")
		}
	}
	t.Setenv("AWARD_FEED_URL", "")
	if refresh(context.Background()) == nil {
		t.Fatal("refresh ran without a source")
	}
	t.Setenv("AWARD_FEED_URL", "http://insecure.invalid")
	if refresh(context.Background()) == nil {
		t.Fatal("insecure source accepted")
	}
}
func TestDepartureCutoff(t *testing.T) {
	now := time.Now()
	scan, it := example(now, "HND")
	it.Segments[0].Departure = now.Add(95 * time.Hour)
	it.Segments[0].Arrival = now.Add(106 * time.Hour)
	scan.Date = it.Segments[0].Departure.In(sfoLocation).Format("2006-01-02")
	if eligible(it, scan, now, 1) {
		t.Fatal("flight within 96 hours accepted")
	}
}
