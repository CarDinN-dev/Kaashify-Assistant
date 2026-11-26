// Kaashify Chrome Native Messaging transport. Chrome supplies the extension
// origin as the first argument. The desktop supplies the per-launch pipe.
package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

const maxFrame = 128 * 1024

var (
	originPattern = regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`)
	pipePattern   = regexp.MustCompile(`^\\\\\.\\pipe\\kaashify-chrome-[0-9a-f]{36}$`)
	tokenPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type bridgeConfig struct {
	Pipe   string `json:"pipe"`
	Token  string `json:"token"`
	Origin string `json:"origin"`
}

func relay(dst io.Writer, src io.Reader) error {
	var header [4]byte
	for {
		if _, err := io.ReadFull(src, header[:]); err != nil {
			return err
		}
		size := binary.LittleEndian.Uint32(header[:])
		if size == 0 || size > maxFrame {
			return io.ErrUnexpectedEOF
		}
		if _, err := dst.Write(header[:]); err != nil {
			return err
		}
		if _, err := io.CopyN(dst, src, int64(size)); err != nil {
			return err
		}
	}
}

func main() {
	if len(os.Args) < 2 || !originPattern.MatchString(os.Args[1]) {
		return
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	file, err := os.Open(filepath.Join(dir, "Kaashify", "chrome-bridge.json"))
	if err != nil {
		return
	}
	defer file.Close()
	var config bridgeConfig
	err = json.NewDecoder(io.LimitReader(file, 4096)).Decode(&config)
	if err != nil || config.Origin != os.Args[1] || !pipePattern.MatchString(config.Pipe) || !tokenPattern.MatchString(config.Token) {
		return
	}
	pipe, err := os.OpenFile(config.Pipe, os.O_RDWR, 0)
	if err != nil {
		return
	}
	defer pipe.Close()
	token, _ := json.Marshal(map[string]string{"token": config.Token})
	if err := binary.Write(pipe, binary.LittleEndian, uint32(len(token))); err != nil {
		return
	}
	if _, err := pipe.Write(token); err != nil {
		return
	}
	done := make(chan error, 2)
	go func() { done <- relay(pipe, os.Stdin) }()
	go func() { done <- relay(os.Stdout, pipe) }()
	<-done
}
