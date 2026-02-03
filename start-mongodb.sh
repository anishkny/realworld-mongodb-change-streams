docker pull mongo:latest
docker rm -f mongo-local
docker run --name mongo-local -p 27017:27017 mongo:latest --replSet rs0 &
sleep 5
docker exec mongo-local mongosh --eval 'db.runCommand({ ping: 1})'
docker exec mongo-local mongosh --eval "rs.initiate()"
