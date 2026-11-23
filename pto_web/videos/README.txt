Put the videos for the Sing-Along room here (the room behind the TV in the Backyard).

* .mp4 (H.264 video, AAC sound) plays in every browser; .webm (VP8 / VP9, Vorbis / Opus) in Chrome, Edge, Opera and Firefox.
  .m4v, .ogv, .mov and .mkv are offered to the browser as well, but play only if the browser knows what is inside them.
* Each file becomes a button on the TV, in the order of the file names (numbers by their value: "2 ..." comes before "10 ...").
  A number and a dash at the start of a name ("01 - ") only sets the order; it is not shown. Up to 36 videos fit on the TV.
* The picture on a button is a frame of the video, made by the page.
* The folder is read when the page opens: after adding or removing a file, reload the page (Ctrl+F5).
* Another web server than serve.py cannot list this folder for the page: write a file called videos.json here instead,
  for example ["01 - Hot Potato.mp4", "02 - The Wheels on the Bus.mp4"]
  (or [{"file": "hot-potato.mp4", "title": "Hot Potato"}] to choose the name shown on the button).
* An old .flv video can be converted with ffmpeg:   ffmpeg -i in.flv -c:v libx264 -c:a aac out.mp4
* With no videos here, the room plays one of the sounds in ../sounds (NOVIDEOS1.mp3 ... NOVIDEOS8.mp3) when it opens.

Videos can also be added from anywhere on the computer with the "Videos..." button on the page, or by dropping them on the page.
Those stay only until the page is closed.  See ../README.md, section 5.
