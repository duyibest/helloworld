package main

import (
	"errors"
	"fmt"
	"time"
	_ "time/tzdata"
)

type Segment struct {
	Origin      string    `json:"origin"`
	Destination string    `json:"destination"`
	Operator    string    `json:"operator"`
	Flight      string    `json:"flight"`
	Cabin       string    `json:"cabin"`
	Status      string    `json:"status"`
	Departure   time.Time `json:"departure"`
	Arrival     time.Time `json:"arrival"`
	Seats       int       `json:"seats"`
}
type Itinerary struct {
	ID       string    `json:"id"`
	Status   string    `json:"status"`
	Seats    int       `json:"seats"`
	Miles    int       `json:"miles"`
	Taxes    string    `json:"taxes,omitempty"`
	Segments []Segment `json:"segments"`
}
type Scan struct {
	Date        string      `json:"date"`
	Destination string      `json:"destination"`
	Status      string      `json:"status"`
	CheckedAt   time.Time   `json:"checked_at"`
	Itineraries []Itinerary `json:"itineraries"`
}
type Snapshot struct {
	Version     int       `json:"version"`
	Program     string    `json:"program"`
	Source      string    `json:"source"`
	GeneratedAt time.Time `json:"generated_at"`
	Scans       []Scan    `json:"scans"`
}
type Day struct {
	Date        string      `json:"date"`
	Destination string      `json:"destination"`
	Status      string      `json:"status"`
	CheckedAt   *time.Time  `json:"checked_at,omitempty"`
	Results     []Itinerary `json:"results"`
}
type Dashboard struct {
	Program      string     `json:"program"`
	Source       string     `json:"source"`
	Connected    bool       `json:"connected"`
	State        string     `json:"state"`
	GeneratedAt  *time.Time `json:"generated_at,omitempty"`
	HorizonStart string     `json:"horizon_start"`
	HorizonEnd   string     `json:"horizon_end"`
	FreshHours   int        `json:"fresh_hours"`
	Days         []Day      `json:"days"`
}

var sfoLocation = mustLocation("America/Los_Angeles")

func mustLocation(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}
func midnight(now time.Time) time.Time {
	y, m, d := now.In(sfoLocation).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, sfoLocation)
}
func validDestination(s string) bool { return s == "HND" || s == "NRT" || s == "PVG" }
func validateSnapshot(s Snapshot, now time.Time) error {
	if s.Version != 1 || s.Program != "ANA Mileage Club" || s.Source == "" {
		return errors.New("expected version 1, ANA Mileage Club program, and a named source")
	}
	if s.GeneratedAt.IsZero() || s.GeneratedAt.After(now.Add(5*time.Minute)) {
		return errors.New("invalid snapshot timestamp")
	}
	seen := map[string]bool{}
	for _, scan := range s.Scans {
		key := scan.Date + scan.Destination
		if seen[key] {
			return fmt.Errorf("duplicate route/date: %s", key)
		}
		seen[key] = true
		if _, err := time.Parse("2006-01-02", scan.Date); err != nil || !validDestination(scan.Destination) {
			return errors.New("invalid scan route or date")
		}
		if scan.Status != "complete" && scan.Status != "blocked" && scan.Status != "error" {
			return errors.New("invalid scan status")
		}
		if scan.CheckedAt.IsZero() || scan.CheckedAt.After(now.Add(5*time.Minute)) || scan.CheckedAt.After(s.GeneratedAt.Add(time.Minute)) {
			return errors.New("invalid check timestamp")
		}
	}
	return nil
}
func eligible(it Itinerary, scan Scan, now time.Time, passengers int) bool {
	if it.ID == "" || it.Status != "available" || it.Seats < passengers || it.Miles <= 0 || len(it.Segments) == 0 {
		return false
	}
	if scan.Destination == "PVG" {
		if len(it.Segments) != 2 {
			return false
		}
	} else if len(it.Segments) != 1 {
		return false
	}
	for i, leg := range it.Segments {
		if leg.Operator != "NH" || leg.Status != "available" || leg.Seats < passengers || !leg.Arrival.After(leg.Departure) {
			return false
		}
		if i == 0 {
			if leg.Cabin != "business" {
				return false
			}
			if leg.Origin != "SFO" || leg.Departure.In(sfoLocation).Format("2006-01-02") != scan.Date || leg.Departure.Before(now.Add(96*time.Hour)) {
				return false
			}
		} else {
			if leg.Cabin != "business" && leg.Cabin != "economy" {
				return false
			}
			prev := it.Segments[i-1]
			// Only a same-airport Tokyo connection; never infer a ticket from separate legs.
			if leg.Origin != prev.Destination || (leg.Origin != "HND" && leg.Origin != "NRT") || !leg.Departure.After(prev.Arrival) || leg.Departure.Sub(prev.Arrival) > 24*time.Hour {
				return false
			}
		}
	}
	return it.Segments[len(it.Segments)-1].Destination == scan.Destination
}
func dashboard(s *Snapshot, now time.Time, passengers int, state string) Dashboard {
	start := midnight(now)
	end := start.AddDate(0, 0, 355)
	out := Dashboard{Program: "ANA Mileage Club", Source: "Not connected", State: state, HorizonStart: start.Format("2006-01-02"), HorizonEnd: end.Format("2006-01-02"), FreshHours: 26, Days: []Day{}}
	index := map[string]Scan{}
	if s != nil {
		out.Connected = true
		out.Source = s.Source
		out.GeneratedAt = &s.GeneratedAt
		for _, scan := range s.Scans {
			index[scan.Date+scan.Destination] = scan
		}
	}
	for date := start; !date.After(end); date = date.AddDate(0, 0, 1) {
		for _, dest := range []string{"HND", "NRT", "PVG"} {
			day := Day{Date: date.Format("2006-01-02"), Destination: dest, Status: "unchecked", Results: []Itinerary{}}
			if scan, ok := index[day.Date+dest]; ok {
				checked := scan.CheckedAt
				day.CheckedAt = &checked
				switch {
				case now.Sub(checked) > 26*time.Hour:
					day.Status = "stale"
				case scan.Status == "blocked":
					day.Status = "blocked"
				case scan.Status == "error":
					day.Status = "error"
				default:
					// A complete search with excluded/ambiguous results is not proof of no seats.
					day.Status = "unavailable"
					for _, it := range scan.Itineraries {
						if eligible(it, scan, now, passengers) {
							day.Results = append(day.Results, it)
						}
					}
					if len(day.Results) > 0 {
						day.Status = "available"
					} else if len(scan.Itineraries) > 0 {
						day.Status = "excluded"
					}
				}
			}
			// If the latest snapshot could not be loaded, never present cached seats as fresh.
			if state == "error" && day.Status == "available" {
				day.Status = "stale"
				day.Results = []Itinerary{}
			}
			out.Days = append(out.Days, day)
		}
	}
	return out
}
